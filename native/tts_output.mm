#include "tts_output.h"

#import <AudioToolbox/AudioToolbox.h>
#import <CoreAudio/CoreAudio.h>
#import <Foundation/Foundation.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "devices.h"
#include "diagnostics.h"
#include "napi_util.h"

namespace babelvoice {

namespace {

// TTS output: AudioUnit (HAL output) + FIFO feeder + lock-free SPSC ring.
//
// We can't use AudioQueue for streaming output to a virtual device because the
// device's IO proc deactivates whenever the queue's buffer list empties and
// doesn't reliably resume on the next enqueue (BabelVoice/BlackHole). With
// HAL AudioUnit, the system continuously calls our render callback at the
// device's pace; when the ring is empty we return silence, so the IO proc
// stays continuously active and reactivates instantly when real audio arrives.
//
// The FIFO owns full TTS chunks behind a bounded backlog; the ring is only the
// real-time handoff to the audio render thread.
constexpr size_t kTtsRingCapacity = 1u << 16;  // 65536 Int16 samples ≈ 4s @16kHz
constexpr size_t kTtsRingMask = kTtsRingCapacity - 1;
// Backlog cap in time, not samples: a fixed sample count gave 24 kHz engines
// a third less headroom than 16 kHz ones.
constexpr double kTtsMaxQueuedSeconds = 120;
static_assert((kTtsRingCapacity & kTtsRingMask) == 0, "ring capacity must be a power of two");

// Owns one HAL output AudioUnit instance.
class ScopedAudioUnit {
 public:
  ScopedAudioUnit() = default;
  ~ScopedAudioUnit() { Reset(); }
  ScopedAudioUnit(const ScopedAudioUnit &) = delete;
  ScopedAudioUnit &operator=(const ScopedAudioUnit &) = delete;

  AudioUnit get() const { return unit_; }
  explicit operator bool() const { return unit_ != nullptr; }
  // For AudioComponentInstanceNew. Disposes what was held.
  AudioUnit *Out() {
    Reset();
    return &unit_;
  }
  void Stop() {
    if (unit_) AudioOutputUnitStop(unit_);
  }
  // Uninitialize + dispose. Stop() first: the render callback must be done.
  void Reset() {
    if (!unit_) return;
    AudioUnitUninitialize(unit_);
    AudioComponentInstanceDispose(unit_);
    unit_ = nullptr;
  }

 private:
  AudioUnit unit_ = nullptr;
};

AudioDeviceID CurrentAudioOutputUnitDevice(AudioUnit unit) {
  if (!unit) return kAudioObjectUnknown;
  AudioDeviceID device = kAudioObjectUnknown;
  UInt32 size = sizeof(device);
  OSStatus status = AudioUnitGetProperty(
    unit,
    kAudioOutputUnitProperty_CurrentDevice,
    kAudioUnitScope_Global,
    0,
    &device,
    &size
  );
  if (status != noErr) return kAudioObjectUnknown;
  return device;
}

class TtsOutput {
 public:
  TtsOutput() : diag_(TtsDiagnostics()) {}

  // --- Mic passthrough flag. ---
  std::atomic_bool micPassthroughEnabled{false};
  void ArmPrebuffer() { prebuffering_.store(true, std::memory_order_release); }

  Float64 unitSampleRate() const { return unitSampleRate_; }  // JS thread

  bool Prepare(Float64 sampleRate, const std::string &devicePattern, std::string &error);
  // JS thread. False (after recording the error) on backlog overflow.
  bool Enqueue(const int16_t *src, size_t sampleCount, Float64 sampleRate, std::string &error);
  void Tee(const int16_t *src, size_t sampleCount, Float64 sampleRate);
  void Flush();
  void Dispose();
  double PendingMs();
  void ReportPlayed(const void *bytes, size_t length) {
    UpdateDiagnostics(diag_, bytes, length, outputRouteStatus_);
  }

 private:
  static OSStatus RenderCallback(
    void *refCon,
    AudioUnitRenderActionFlags *flags,
    const AudioTimeStamp *,
    UInt32,
    UInt32 numFrames,
    AudioBufferList *ioData);
  OSStatus Render(AudioUnitRenderActionFlags *flags, UInt32 numFrames, AudioBufferList *ioData);

  uint64_t RingPending();
  void RequestRingSkipTo(uint64_t index);
  void ClearQueueLocked();
  uint64_t DropQueueFrontLocked(uint64_t count);
  void ResetRing();
  void FeederLoop();
  bool StartFeeder(std::string &error);
  void StopFeeder();
  void ConfigurePassthroughThresholds(Float64 sampleRate);

  NativeDiagnostics &diag_;

  int16_t ring_[kTtsRingCapacity];
  std::atomic<uint64_t> ringWrite_{0};  // producer (TTS feeder thread)
  std::atomic<uint64_t> ringRead_{0};   // consumer (audio render thread)
  // "Discard everything below this ring index" — how flush and the passthrough
  // latency cap drop audio. Only the render thread ever moves ringRead_, so
  // the ring stays strictly SPSC; other threads just raise this watermark.
  std::atomic<uint64_t> ringSkipTo_{0};

  // Passthrough jitter buffer. AudioQueue delivers mic audio in 40ms bursts
  // with jitter while the render thread pulls ~10ms per cycle, so playing from
  // an empty ring crackles. In passthrough mode the render thread waits for
  // prebufferSamples_ before playing and re-arms after an underrun; the
  // producer side caps the backlog at passthroughMaxSamples_ (dropping
  // the oldest audio down to passthroughTargetSamples_) so a stalled
  // device can't leave the call permanently delayed.
  std::atomic_bool prebuffering_{true};
  std::atomic<uint32_t> prebufferSamples_{0};
  std::atomic<uint32_t> passthroughMaxSamples_{0};
  std::atomic<uint32_t> passthroughTargetSamples_{0};

  std::mutex queueMutex_;
  std::condition_variable queueCv_;
  std::deque<std::vector<int16_t>> queue_;  // guarded by queueMutex_
  size_t queueSamples_ = 0;                 // guarded by queueMutex_
  size_t queueFrontOffset_ = 0;             // guarded by queueMutex_
  std::atomic_bool feederRunning_{false};
  std::thread feederThread_;
  // Rate of the running unit for the tee's check (any thread); 0 while
  // there is none or it is being rebuilt.
  std::atomic<Float64> liveSampleRate_{0};

  // JS thread only.
  ScopedAudioUnit unit_;
  Float64 unitSampleRate_ = 0;
  std::string unitDevicePattern_;
  AudioDeviceID unitDevice_ = kAudioObjectUnknown;
  DeviceCheckStamp unitStamp_;
  ListenerSet deviceListeners_;
  char outputRouteStatus_[128] = "idle";
};

TtsOutput &Tts() {
  static TtsOutput *const output = new TtsOutput();
  return *output;
}

// Samples written to the ring that the render thread hasn't played (and
// that weren't flushed). Read the consumer index first: the render thread
// only publishes read <= the write it observed, so a later load of write is
// never behind it.
uint64_t TtsOutput::RingPending() {
  const uint64_t readIdx = ringRead_.load(std::memory_order_acquire);
  const uint64_t writeIdx = ringWrite_.load(std::memory_order_acquire);
  const uint64_t skipTo = std::min(ringSkipTo_.load(std::memory_order_acquire), writeIdx);
  const uint64_t effectiveRead = std::max(readIdx, skipTo);
  return writeIdx > effectiveRead ? writeIdx - effectiveRead : 0;
}

// Ask the render thread to drop everything below `index`. Monotonic, so
// concurrent requests (flush vs. passthrough latency cap) can't undo each
// other.
void TtsOutput::RequestRingSkipTo(uint64_t index) {
  uint64_t current = ringSkipTo_.load(std::memory_order_relaxed);
  while (current < index &&
         !ringSkipTo_.compare_exchange_weak(
           current, index, std::memory_order_acq_rel, std::memory_order_relaxed)) {
  }
}

void TtsOutput::ClearQueueLocked() {
  queue_.clear();
  queueSamples_ = 0;
  queueFrontOffset_ = 0;
  diag_.queuedSamples.store(0, std::memory_order_release);
}

// Drop up to `count` of the oldest queued (not yet in ring) samples.
uint64_t TtsOutput::DropQueueFrontLocked(uint64_t count) {
  uint64_t dropped = 0;
  while (count > 0 && !queue_.empty()) {
    std::vector<int16_t> &front = queue_.front();
    const size_t remaining = front.size() - queueFrontOffset_;
    const size_t take = static_cast<size_t>(std::min<uint64_t>(count, remaining));
    queueFrontOffset_ += take;
    queueSamples_ -= take;
    count -= take;
    dropped += take;
    if (queueFrontOffset_ >= front.size()) {
      queue_.pop_front();
      queueFrontOffset_ = 0;
    }
  }
  return dropped;
}

// Only valid while nothing renders and the feeder is stopped (unit stopped or
// not yet started). Under the queue mutex because the mic tee reads the
// indices.
void TtsOutput::ResetRing() {
  std::lock_guard<std::mutex> lock(queueMutex_);
  ringWrite_.store(0, std::memory_order_release);
  ringRead_.store(0, std::memory_order_release);
  ringSkipTo_.store(0, std::memory_order_release);
  prebuffering_.store(true, std::memory_order_release);
}

// Runs on the JS thread and never writes ringRead_ (that index belongs to the
// render thread — writing it here let a concurrent render cycle rewind it and
// replay flushed audio).
void TtsOutput::Flush() {
  {
    std::lock_guard<std::mutex> lock(queueMutex_);
    ClearQueueLocked();
    // The feeder only writes the ring while holding this mutex, so the write
    // index is stable here: everything below it is pre-flush audio.
    RequestRingSkipTo(ringWrite_.load(std::memory_order_acquire));
    prebuffering_.store(true, std::memory_order_release);
  }
  diag_.ringSamples.store(0, std::memory_order_release);
  SetRouteStatus(diag_, "idle");
  queueCv_.notify_all();
}

void TtsOutput::FeederLoop() {
  std::unique_lock<std::mutex> lock(queueMutex_);
  while (true) {
    queueCv_.wait(lock, [this] {
      return !feederRunning_.load(std::memory_order_acquire) || !queue_.empty();
    });
    if (!feederRunning_.load(std::memory_order_acquire)) break;

    while (feederRunning_.load(std::memory_order_acquire) && !queue_.empty()) {
      const uint64_t writeIdx = ringWrite_.load(std::memory_order_relaxed);
      const uint64_t readIdx = ringRead_.load(std::memory_order_acquire);
      const uint64_t inFlight = writeIdx - readIdx;
      if (inFlight >= kTtsRingCapacity) {
        // The ring holds seconds of audio, so there is no need to poll hard
        // for space; flush/stop notify the cv and wake us early.
        diag_.ringSamples.store(kTtsRingCapacity, std::memory_order_release);
        queueCv_.wait_for(lock, std::chrono::milliseconds(50));
        continue;
      }

      const size_t freeSamples = static_cast<size_t>(kTtsRingCapacity - inFlight);
      std::vector<int16_t> &front = queue_.front();
      const size_t frontRemaining = front.size() - queueFrontOffset_;
      const size_t toWrite = std::min(freeSamples, frontRemaining);

      for (size_t i = 0; i < toWrite; i++) {
        ring_[(writeIdx + i) & kTtsRingMask] = front[queueFrontOffset_ + i];
      }
      ringWrite_.store(writeIdx + toWrite, std::memory_order_release);

      queueFrontOffset_ += toWrite;
      queueSamples_ -= toWrite;
      diag_.queuedSamples.store(queueSamples_, std::memory_order_release);
      diag_.ringSamples.store(inFlight + toWrite, std::memory_order_release);
      SetRouteStatus(diag_, "buffering");

      if (queueFrontOffset_ >= front.size()) {
        queue_.pop_front();
        queueFrontOffset_ = 0;
      }
    }
  }
}

bool TtsOutput::StartFeeder(std::string &error) {
  (void)error;
  if (feederRunning_.load(std::memory_order_acquire)) return true;
  feederRunning_.store(true, std::memory_order_release);
  feederThread_ = std::thread([this] { FeederLoop(); });
  return true;
}

void TtsOutput::StopFeeder() {
  feederRunning_.store(false, std::memory_order_release);
  {
    std::lock_guard<std::mutex> lock(queueMutex_);
    ClearQueueLocked();
  }
  queueCv_.notify_all();
  if (feederThread_.joinable()) {
    feederThread_.join();
  }
}

OSStatus TtsOutput::RenderCallback(
  void *refCon,
  AudioUnitRenderActionFlags *flags,
  const AudioTimeStamp *,
  UInt32,
  UInt32 numFrames,
  AudioBufferList *ioData
) {
  // `refCon` is the process-lifetime TtsOutput: no lookup, no guard.
  return static_cast<TtsOutput *>(refCon)->Render(flags, numFrames, ioData);
}

// HAL IO thread: no allocation, no locks, no ObjC.
OSStatus TtsOutput::Render(AudioUnitRenderActionFlags *flags, UInt32 numFrames, AudioBufferList *ioData) {
  if (!ioData || ioData->mNumberBuffers == 0) return noErr;
  AudioBuffer &buf = ioData->mBuffers[0];
  int16_t *out = static_cast<int16_t *>(buf.mData);
  const UInt32 capacity = buf.mDataByteSize / sizeof(int16_t);
  const UInt32 frames = std::min(numFrames, capacity);

  uint64_t readIdx = ringRead_.load(std::memory_order_relaxed);
  const uint64_t writeIdx = ringWrite_.load(std::memory_order_acquire);
  // Flush / latency-cap requests: skip ahead, never past the producer.
  const uint64_t skipTo = std::min(ringSkipTo_.load(std::memory_order_acquire), writeIdx);
  if (skipTo > readIdx) readIdx = skipTo;
  const uint64_t available = writeIdx - readIdx;
  UInt32 toRead = static_cast<UInt32>(std::min<uint64_t>(frames, available));

  if (micPassthroughEnabled.load(std::memory_order_relaxed)) {
    if (prebuffering_.load(std::memory_order_relaxed)) {
      if (available < prebufferSamples_.load(std::memory_order_relaxed)) {
        toRead = 0;  // still filling the jitter buffer
      } else {
        prebuffering_.store(false, std::memory_order_relaxed);
      }
    } else if (toRead < frames) {
      // Ran dry mid-stream: play what's left, then re-arm the prebuffer
      // instead of crackling on every late AudioQueue chunk.
      diag_.underruns.fetch_add(1, std::memory_order_relaxed);
      prebuffering_.store(true, std::memory_order_relaxed);
    }
  }

  for (UInt32 i = 0; i < toRead; i++) {
    out[i] = ring_[(readIdx + i) & kTtsRingMask];
  }
  if (toRead < frames) {
    std::memset(out + toRead, 0, (frames - toRead) * sizeof(int16_t));
    if (toRead == 0 && flags) {
      *flags |= kAudioUnitRenderAction_OutputIsSilence;
    }
  }
  ringRead_.store(readIdx + toRead, std::memory_order_release);
  diag_.ringSamples.store(available - toRead, std::memory_order_release);
  buf.mDataByteSize = frames * sizeof(int16_t);
  return noErr;
}

void TtsOutput::Dispose() {
  unit_.Stop();
  StopFeeder();
  deviceListeners_.Clear();
  unit_.Reset();
  unitSampleRate_ = 0;
  liveSampleRate_.store(0, std::memory_order_release);
  unitDevicePattern_.clear();
  unitDevice_ = kAudioObjectUnknown;
  unitStamp_ = {};
  ResetRing();
  diag_.ringSamples.store(0, std::memory_order_release);
  diag_.droppedSamples.store(0, std::memory_order_release);
  diag_.underruns.store(0, std::memory_order_release);
  CopyCString(outputRouteStatus_, sizeof(outputRouteStatus_), "idle");
  SetRouteStatus(diag_, "idle");
}

void TtsOutput::ConfigurePassthroughThresholds(Float64 sampleRate) {
  // ~60ms jitter buffer; passthrough latency capped at ~300ms and trimmed
  // back to ~120ms when exceeded.
  prebufferSamples_.store(static_cast<uint32_t>(sampleRate * 0.060), std::memory_order_relaxed);
  passthroughMaxSamples_.store(static_cast<uint32_t>(sampleRate * 0.300), std::memory_order_relaxed);
  passthroughTargetSamples_.store(static_cast<uint32_t>(sampleRate * 0.120), std::memory_order_relaxed);
}

bool TtsOutput::Prepare(Float64 sampleRate, const std::string &devicePattern, std::string &error) {
  if (unit_ && unitSampleRate_ == sampleRate && unitDevicePattern_ == devicePattern) {
    // Hot path (every playPcm): skip the device walk unless the topology
    // changed since the unit was last validated.
    if (DeviceStampFresh(unitStamp_)) {
      return StartFeeder(error);
    }
    const DeviceCheckStamp stamp = CurrentDeviceStamp();
    const AudioDeviceID currentDevice = CurrentAudioOutputUnitDevice(unit_.get());
    const AudioDeviceID expectedDevice = FindVirtualOutputDeviceID(devicePattern);
    if (currentDevice == expectedDevice &&
        IsSafeVirtualOutputDevice(currentDevice, devicePattern)) {
      unitStamp_ = stamp;
      return StartFeeder(error);
    }
    Dispose();
  }
  if (unit_) Dispose();

  const DeviceCheckStamp stamp = CurrentDeviceStamp();
  AudioDeviceID deviceId = FindVirtualOutputDeviceID(devicePattern);
  if (deviceId == kAudioObjectUnknown) {
    error = "BabelVoice/BlackHole output device not found";
    return false;
  }
  if (!IsSafeVirtualOutputDevice(deviceId, devicePattern)) {
    error = "BabelVoice/BlackHole output device is not a safe virtual output";
    return false;
  }

  AudioComponentDescription desc{};
  desc.componentType = kAudioUnitType_Output;
  desc.componentSubType = kAudioUnitSubType_HALOutput;
  desc.componentManufacturer = kAudioUnitManufacturer_Apple;
  AudioComponent comp = AudioComponentFindNext(nullptr, &desc);
  if (!comp) {
    error = "HAL output AudioComponent not found";
    return false;
  }

  OSStatus status = AudioComponentInstanceNew(comp, unit_.Out());
  if (status != noErr || !unit_) {
    error = "AudioComponentInstanceNew failed";
    return false;
  }

  UInt32 enableOutput = 1;
  status = AudioUnitSetProperty(
    unit_.get(),
    kAudioOutputUnitProperty_EnableIO,
    kAudioUnitScope_Output,
    0,
    &enableOutput,
    sizeof(enableOutput)
  );
  if (status != noErr) {
    Dispose();
    error = "AudioUnitSetProperty(EnableIO) failed";
    return false;
  }

  status = AudioUnitSetProperty(
    unit_.get(),
    kAudioOutputUnitProperty_CurrentDevice,
    kAudioUnitScope_Global,
    0,
    &deviceId,
    sizeof(deviceId)
  );
  if (status != noErr) {
    Dispose();
    error = "AudioUnitSetProperty(CurrentDevice) failed";
    return false;
  }

  const AudioDeviceID actualDeviceId = CurrentAudioOutputUnitDevice(unit_.get());
  if (actualDeviceId != deviceId || !IsSafeVirtualOutputDevice(actualDeviceId, devicePattern)) {
    Dispose();
    error = "HAL output did not bind to the virtual device";
    return false;
  }

  AudioStreamBasicDescription asbd{};
  asbd.mSampleRate = sampleRate;
  asbd.mFormatID = kAudioFormatLinearPCM;
  asbd.mFormatFlags = kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked;
  asbd.mBytesPerPacket = 2;
  asbd.mFramesPerPacket = 1;
  asbd.mBytesPerFrame = 2;
  asbd.mChannelsPerFrame = 1;
  asbd.mBitsPerChannel = 16;
  status = AudioUnitSetProperty(
    unit_.get(),
    kAudioUnitProperty_StreamFormat,
    kAudioUnitScope_Input,
    0,
    &asbd,
    sizeof(asbd)
  );
  if (status != noErr) {
    Dispose();
    error = "AudioUnitSetProperty(StreamFormat) failed";
    return false;
  }

  AURenderCallbackStruct cb{};
  cb.inputProc = RenderCallback;
  cb.inputProcRefCon = this;
  status = AudioUnitSetProperty(
    unit_.get(),
    kAudioUnitProperty_SetRenderCallback,
    kAudioUnitScope_Input,
    0,
    &cb,
    sizeof(cb)
  );
  if (status != noErr) {
    Dispose();
    error = "AudioUnitSetProperty(SetRenderCallback) failed";
    return false;
  }

  ResetRing();
  ConfigurePassthroughThresholds(sampleRate);

  status = AudioUnitInitialize(unit_.get());
  if (status != noErr) {
    Dispose();
    error = "AudioUnitInitialize failed";
    return false;
  }

  status = AudioOutputUnitStart(unit_.get());
  if (status != noErr) {
    Dispose();
    error = "AudioOutputUnitStart failed";
    return false;
  }

  if (!StartFeeder(error)) {
    Dispose();
    return false;
  }

  unitSampleRate_ = sampleRate;
  liveSampleRate_.store(sampleRate, std::memory_order_release);
  unitDevicePattern_ = devicePattern;
  unitDevice_ = deviceId;
  unitStamp_ = stamp;
  // The device going away (driver reinstall, etc.) must invalidate the hot
  // path so the next chunk re-validates and recreates the unit.
  if (!deviceListeners_.Add(
        deviceId,
        kAudioDevicePropertyDeviceIsAlive,
        kAudioObjectPropertyScopeGlobal,
        ^(UInt32, const AudioObjectPropertyAddress *) { BumpDeviceTopology(); })) {
    unitStamp_ = {};  // can't be told about device death: always re-check
  }
  NSString *routeName = CopyStringProperty(deviceId, kAudioObjectPropertyName) ?: @"unknown";
  NSString *routeUid = CopyStringProperty(deviceId, kAudioDevicePropertyDeviceUID) ?: @"unknown";
  char routeStatus[128];
  std::snprintf(
    routeStatus,
    sizeof(routeStatus),
    "virtual-output:%s:%s",
    routeName.UTF8String,
    routeUid.UTF8String
  );
  SetRouteStatus(diag_, routeStatus);
  CopyCString(outputRouteStatus_, sizeof(outputRouteStatus_), routeStatus);
  return true;
}

bool TtsOutput::Enqueue(const int16_t *src, size_t sampleCount, Float64 sampleRate, std::string &error) {
  const uint64_t maxQueuedSamples = static_cast<uint64_t>(kTtsMaxQueuedSeconds * sampleRate);
  std::vector<int16_t> chunk(src, src + sampleCount);
  {
    std::lock_guard<std::mutex> lock(queueMutex_);
    const uint64_t backlog = RingPending() + queueSamples_;
    if (backlog + sampleCount > maxQueuedSamples) {
      diag_.droppedSamples.fetch_add(sampleCount, std::memory_order_acq_rel);
      SetLastError(diag_, "TTS output backlog overflow");
      error = "TTS output backlog overflow";
      return false;
    }
    queueSamples_ += sampleCount;
    diag_.queuedSamples.store(queueSamples_, std::memory_order_release);
    queue_.emplace_back(std::move(chunk));
  }
  queueCv_.notify_one();
  return true;
}

void TtsOutput::Tee(const int16_t *src, size_t sampleCount, Float64 sampleRate) {
  if (!src || sampleCount == 0) return;
  std::lock_guard<std::mutex> lock(queueMutex_);
  // No output unit / feeder: nothing would ever drain the queue. A unit at
  // another rate (a 16 kHz engine's TTS) would play the voice pitch-shifted.
  if (!feederRunning_.load(std::memory_order_acquire)) return;
  if (liveSampleRate_.load(std::memory_order_acquire) != sampleRate) return;
  queue_.emplace_back(src, src + sampleCount);
  queueSamples_ += sampleCount;

  const uint64_t maxSamples = passthroughMaxSamples_.load(std::memory_order_relaxed);
  const uint64_t ringPending = RingPending();
  const uint64_t backlog = ringPending + queueSamples_;
  if (maxSamples > 0 && backlog > maxSamples) {
    const uint64_t target = passthroughTargetSamples_.load(std::memory_order_relaxed);
    uint64_t excess = backlog - std::min(backlog, target);
    // The oldest audio sits in the ring: skip it first, then trim the queue.
    const uint64_t fromRing = std::min(excess, ringPending);
    if (fromRing > 0) {
      // The feeder only writes the ring under this mutex, so write is stable.
      const uint64_t writeIdx = ringWrite_.load(std::memory_order_acquire);
      RequestRingSkipTo(writeIdx - ringPending + fromRing);
      excess -= fromRing;
    }
    const uint64_t fromQueue = DropQueueFrontLocked(excess);
    diag_.droppedSamples.fetch_add(fromRing + fromQueue, std::memory_order_relaxed);
  }
  diag_.queuedSamples.store(queueSamples_, std::memory_order_release);
  queueCv_.notify_one();
}

double TtsOutput::PendingMs() {
  if (!unit_ || unitSampleRate_ <= 0) return 0;
  uint64_t pending = 0;
  {
    std::lock_guard<std::mutex> lock(queueMutex_);
    pending = queueSamples_ + RingPending();
  }
  return static_cast<double>(pending) * 1000.0 / unitSampleRate_;
}

}  // namespace

bool MicPassthroughEnabled() {
  return Tts().micPassthroughEnabled.load(std::memory_order_acquire);
}

void SetMicPassthroughFlag(bool enabled) {
  Tts().micPassthroughEnabled.store(enabled, std::memory_order_release);
}

bool ClearMicPassthroughFlag() {
  return Tts().micPassthroughEnabled.exchange(false, std::memory_order_acq_rel);
}

void ArmTtsPrebuffer() {
  Tts().ArmPrebuffer();
}

void TeeMicToTtsQueue(const int16_t *src, size_t sampleCount, double sampleRate) {
  Tts().Tee(src, sampleCount, sampleRate);
}

double TtsUnitSampleRate() {
  return Tts().unitSampleRate();
}

void FlushTtsOutputUnit() {
  Tts().Flush();
}

void DisposeTtsOutput() {
  Tts().Dispose();
}

napi_value PrepareTtsOutput(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  Float64 sampleRate = kDefaultCaptureSampleRate;
  if (!TtsSampleRateArg(env, args, argc, 0, sampleRate)) return nullptr;
  std::string pattern = kDefaultVirtualPattern;
  if (argc >= 2) {
    pattern = StringArg(env, args[1]);
  }

  std::string error;
  if (!Tts().Prepare(sampleRate, pattern, error)) {
    Throw(env, error.c_str());
    return nullptr;
  }
  return MakeBool(env, true);
}

napi_value PlayPcm(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1) {
    Throw(env, "playPcm requires a Buffer");
    return nullptr;
  }
  Float64 sampleRate = kDefaultCaptureSampleRate;
  if (!TtsSampleRateArg(env, args, argc, 1, sampleRate)) return nullptr;
  std::string pattern = kDefaultVirtualPattern;
  if (argc >= 3) {
    pattern = StringArg(env, args[2]);
  }

  bool isBuffer = false;
  napi_is_buffer(env, args[0], &isBuffer);
  if (!isBuffer) {
    Throw(env, "playPcm first argument must be a Buffer");
    return nullptr;
  }
  void *bytes = nullptr;
  size_t length = 0;
  napi_get_buffer_info(env, args[0], &bytes, &length);
  if (!bytes || length == 0) return MakeBool(env, true);
  // Last line of defence: NativeTtsSink re-pairs odd chunks before they get
  // here, so this only trips on a caller that bypasses it.
  if ((length % sizeof(int16_t)) != 0) {
    Throw(env, "playPcm buffer length must be a multiple of 2 (Int16 samples)");
    return nullptr;
  }

  TtsOutput &tts = Tts();
  std::string error;
  if (!tts.Prepare(sampleRate, pattern, error)) {
    Throw(env, error.c_str());
    return nullptr;
  }
  if (!tts.Enqueue(static_cast<const int16_t *>(bytes), length / sizeof(int16_t), sampleRate, error)) {
    Throw(env, error.c_str());
    return nullptr;
  }
  tts.ReportPlayed(bytes, length);
  return MakeBool(env, true);
}

napi_value CloseTtsOutput(napi_env env, napi_callback_info info) {
  (void)info;
  Tts().Dispose();
  return MakeBool(env, true);
}

napi_value FlushTtsOutput(napi_env env, napi_callback_info info) {
  (void)info;
  Tts().Flush();
  return MakeBool(env, true);
}

// Milliseconds of audio handed to playPcm (or the passthrough tee) that the
// render thread hasn't played yet. Lets JS wait for trailing translated
// speech before re-engaging mic passthrough.
napi_value GetTtsPendingMs(napi_env env, napi_callback_info info) {
  (void)info;
  return MakeNumber(env, Tts().PendingMs());
}

}  // namespace babelvoice
