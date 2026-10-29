#include "process_tap.h"

#import <AppKit/AppKit.h>
#import <AudioToolbox/AudioToolbox.h>
#import <CoreAudio/CoreAudio.h>
#if __has_include(<CoreAudio/CATapDescription.h>)
#import <CoreAudio/CATapDescription.h>
#endif
#if __has_include(<CoreAudio/AudioHardwareTapping.h>)
#import <CoreAudio/AudioHardwareTapping.h>
#endif
#import <Foundation/Foundation.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "capture_sink.h"
#include "devices.h"
#include "diagnostics.h"
#include "napi_util.h"
#include "promise_settler.h"
#include "scoped_audio_converter.h"

namespace babelvoice {

namespace {

// ---------------------------------------------------------------------------
// Process Tap (macOS 14.4+) — capture audio output of a single application.
//
// Why: when listen mode also plays the translated TTS through local speakers,
// using ScreenCaptureKit's full-screen audio mix would re-capture our own
// output and feedback-loop forever. Tapping a single meeting process strictly
// excludes the rest of the system, so the loop is impossible by construction.
//
// Pipeline: bundleId -> every Core Audio process object of the app *and its
//   helpers* (Chrome/Meet, Electron apps and new Teams play audio from helper
//   processes, so tapping only the main PID captured silence) ->
//   CATapDescription (mono mixdown, private, unmuted) ->
//   AudioHardwareCreateProcessTap -> tapID ->
//   private aggregate device with the tap as its only sub-tap ->
//   IOProc + AudioConverter (native -> 16k/24k Int16 mono) -> SPSC ring ->
//   pump thread -> JS.
//
// The IOProc runs on a real-time HAL thread: it only converts into memory
// preallocated at start and writes the ring. Allocation, diagnostics and the
// TSFN call happen on the pump thread.
//
// Like SCK, start and stop return promises: building and destroying the tap
// run on TapQueue, never on the JS thread. The JS thread only owns the slot
// (TapSlot::current) and the TSFNs.
// ---------------------------------------------------------------------------

constexpr size_t kTapRingCapacity = 1u << 15;  // ~2s of 16kHz mono, ~1.4s of 24kHz
constexpr size_t kTapRingMask = kTapRingCapacity - 1;
static_assert((kTapRingCapacity & kTapRingMask) == 0, "tap ring capacity must be a power of two");
constexpr auto kTapPumpInterval = std::chrono::milliseconds(20);
constexpr OSStatus kTapNoMoreInput = -1;
constexpr int64_t kTapStopTimeoutNs = 3 * NSEC_PER_SEC;

// --- RAII owners for the HAL objects a tap is built from. All of them are
// only touched on TapQueue (build / teardown). ---

// AudioHardwareCreateProcessTap result.
class ScopedProcessTap {
 public:
  ScopedProcessTap() = default;
  ~ScopedProcessTap() { Reset(); }
  ScopedProcessTap(const ScopedProcessTap &) = delete;
  ScopedProcessTap &operator=(const ScopedProcessTap &) = delete;
  AudioObjectID get() const { return id_; }
  void Adopt(AudioObjectID id) {
    Reset();
    id_ = id;
  }
  void Reset() {
    if (id_ == kAudioObjectUnknown) return;
    if (@available(macOS 14.4, *)) AudioHardwareDestroyProcessTap(id_);
    id_ = kAudioObjectUnknown;
  }

 private:
  AudioObjectID id_ = kAudioObjectUnknown;
};

// AudioHardwareCreateAggregateDevice result.
class ScopedAggregateDevice {
 public:
  ScopedAggregateDevice() = default;
  ~ScopedAggregateDevice() { Reset(); }
  ScopedAggregateDevice(const ScopedAggregateDevice &) = delete;
  ScopedAggregateDevice &operator=(const ScopedAggregateDevice &) = delete;
  AudioObjectID get() const { return id_; }
  void Adopt(AudioObjectID id) {
    Reset();
    id_ = id;
  }
  void Reset() {
    if (id_ == kAudioObjectUnknown) return;
    if (@available(macOS 14.4, *)) AudioHardwareDestroyAggregateDevice(id_);
    id_ = kAudioObjectUnknown;
  }

 private:
  AudioObjectID id_ = kAudioObjectUnknown;
};

// An IOProc registered on a device. Reset() stops the device IO for it
// (synchronous off the IO thread) and destroys it.
class ScopedIOProc {
 public:
  ScopedIOProc() = default;
  ~ScopedIOProc() { Reset(); }
  ScopedIOProc(const ScopedIOProc &) = delete;
  ScopedIOProc &operator=(const ScopedIOProc &) = delete;
  AudioDeviceIOProcID get() const { return proc_; }
  void Adopt(AudioObjectID device, AudioDeviceIOProcID proc) {
    Reset();
    device_ = device;
    proc_ = proc;
  }
  void Reset() {
    if (proc_ && device_ != kAudioObjectUnknown) {
      AudioDeviceStop(device_, proc_);
      AudioDeviceDestroyIOProcID(device_, proc_);
    }
    proc_ = nullptr;
    device_ = kAudioObjectUnknown;
  }

 private:
  AudioObjectID device_ = kAudioObjectUnknown;
  AudioDeviceIOProcID proc_ = nullptr;
};

// A dispatch source that must be cancelled (ARC releases it).
class ScopedDispatchSource {
 public:
  ScopedDispatchSource() = default;
  ~ScopedDispatchSource() { Reset(); }
  ScopedDispatchSource(const ScopedDispatchSource &) = delete;
  ScopedDispatchSource &operator=(const ScopedDispatchSource &) = delete;
  void Adopt(dispatch_source_t source) {
    Reset();
    source_ = source;
  }
  void Reset() {
    if (source_) dispatch_source_cancel(source_);
    source_ = nil;
  }

 private:
  dispatch_source_t source_ = nil;
};

pid_t RunningAppPid(NSString *bundleId) {
  if (bundleId.length == 0) return -1;
  for (NSRunningApplication *app in [NSRunningApplication runningApplicationsWithBundleIdentifier:bundleId]) {
    if (!app.terminated) return app.processIdentifier;
  }
  return -1;
}

bool BundleBelongsTo(const std::string &candidate, const std::string &bundleId) {
  if (candidate == bundleId) return true;
  // Helpers: com.google.Chrome.helper, com.google.Chrome.helper.renderer, …
  return candidate.size() > bundleId.size() &&
         candidate.compare(0, bundleId.size(), bundleId) == 0 &&
         candidate[bundleId.size()] == '.';
}

// Every live Core Audio process object belonging to `bundleId`, sorted.
std::vector<AudioObjectID> FindProcessObjectsForBundle(const std::string &bundleId) {
  std::vector<AudioObjectID> out;
  if (bundleId.empty()) return out;
  AudioObjectPropertyAddress address = {
    kAudioHardwarePropertyProcessObjectList,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain
  };
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, nullptr, &size) != noErr || size == 0) {
    return out;
  }
  std::vector<AudioObjectID> processes(size / sizeof(AudioObjectID));
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, nullptr, &size, processes.data()) != noErr) {
    return out;
  }
  processes.resize(size / sizeof(AudioObjectID));
  // Safari plays media from WebKit's GPU process, whose bundle ID isn't under
  // com.apple.Safari.*. Including it can also pick up media from other WebKit
  // apps — an acceptable trade for Safari meetings working at all.
  const bool safari = bundleId.rfind("com.apple.Safari", 0) == 0;
  for (AudioObjectID process : processes) {
    NSString *processBundleId = CopyStringProperty(process, kAudioProcessPropertyBundleID);
    if (processBundleId.length == 0) continue;
    const std::string candidate(processBundleId.UTF8String);
    if (BundleBelongsTo(candidate, bundleId) || (safari && candidate == "com.apple.WebKit.GPU")) {
      out.push_back(process);
    }
  }
  std::sort(out.begin(), out.end());
  return out;
}

NSArray<NSNumber *> *ProcessIdArray(const std::vector<AudioObjectID> &processes) {
  NSMutableArray<NSNumber *> *ids = [NSMutableArray arrayWithCapacity:processes.size()];
  for (AudioObjectID process : processes) [ids addObject:@(process)];
  return ids;
}

bool ReadInputStreamFormat(AudioObjectID device, AudioStreamBasicDescription &out) {
  AudioObjectPropertyAddress address = {
    kAudioDevicePropertyStreamFormat,
    kAudioObjectPropertyScopeInput,
    kAudioObjectPropertyElementMain
  };
  UInt32 size = sizeof(out);
  return AudioObjectGetPropertyData(device, &address, 0, nullptr, &size, &out) == noErr && out.mSampleRate > 0;
}

// Largest IO cycle the device may hand the IOProc, so the converter's output
// buffer can be allocated once up front.
UInt32 MaxIoBufferFrames(AudioObjectID device) {
  UInt32 frames = 4096;
  AudioObjectPropertyAddress address = {
    kAudioDevicePropertyBufferFrameSizeRange,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain
  };
  AudioValueRange range{};
  UInt32 size = sizeof(range);
  if (AudioObjectGetPropertyData(device, &address, 0, nullptr, &size, &range) == noErr &&
      range.mMaximum > frames) {
    frames = static_cast<UInt32>(range.mMaximum);
  }
  address.mSelector = kAudioDevicePropertyBufferFrameSize;
  UInt32 current = 0;
  size = sizeof(current);
  if (AudioObjectGetPropertyData(device, &address, 0, nullptr, &size, &current) == noErr &&
      current > frames) {
    frames = current;
  }
  return std::min<UInt32>(frames, 1u << 16);
}

struct TapCapture {
  std::shared_ptr<CaptureSink> sink;
  std::string bundleId;
  // HAL objects, built and destroyed on TapQueue (DestroyTapNative resets
  // them in dependency order); IDs also read by monitor blocks under
  // monitorMutex while !tornDown. Declaration order matters for the
  // destructor backstop: members are destroyed in reverse, so the aggregate
  // goes before the tap it wraps, and `ioProc` (declared after everything
  // the IOProc touches) goes first of all.
  ScopedProcessTap tap;
  ScopedAggregateDevice aggregate;
  ScopedAudioConverter converter;
  AudioStreamBasicDescription inputASBD{};  // immutable once IO starts

  // IO-thread state, preallocated at start.
  std::vector<int16_t> scratch;
  UInt32 scratchFrames = 0;
  std::atomic_bool ioEnabled{false};
  std::atomic<int> ioInFlight{0};
  std::atomic_bool formatChanged{false};

  // IOProc (producer) -> pump thread (consumer).
  int16_t ring[kTapRingCapacity];
  std::atomic<uint64_t> ringWrite{0};
  std::atomic<uint64_t> ringRead{0};
  std::atomic<uint64_t> overruns{0};

  ScopedIOProc ioProc;

  std::thread pump;
  std::mutex pumpMutex;
  std::condition_variable pumpCv;
  bool pumpStop = false;  // guarded by pumpMutex

  // Shared with listener blocks on the monitor queue.
  std::mutex monitorMutex;
  bool tornDown = false;                  // guarded by monitorMutex
  CATapDescription *description = nil;    // guarded by monitorMutex
  std::vector<AudioObjectID> processes;   // guarded by monitorMutex

  ListenerSet listeners;            // tap queue only
  ScopedDispatchSource exitSource;  // tap queue only

  // Set (JS thread) once JS stopped this capture; a start still queued then
  // skips building it. Settled with failure on stop if still pending.
  std::atomic_bool stopRequested{false};
  std::shared_ptr<PromiseSettler> startSettler;  // immutable after creation

  ~TapCapture() {
    // Never std::terminate on a joinable thread, whatever path got us here.
    if (pump.joinable()) pump.detach();
  }
};

struct TapSlot {
  std::shared_ptr<TapCapture> current;  // JS thread only
  // Taps whose IOProc never drained (shouldn't happen — AudioDeviceStop is
  // synchronous off the IO thread); kept alive rather than risk a
  // use-after-free.
  std::vector<std::shared_ptr<TapCapture>> leaked;  // tap queue only
};

TapSlot &Slot() {
  static TapSlot *const slot = new TapSlot();
  return *slot;
}

// Builds and tears down every tap. Creating the tap + aggregate device and
// destroying them (DestroyTapNative may wait up to 1s for the IOProc) used to
// block the JS thread — every window and IPC froze meanwhile. Serial, so
// starts and stops run in call order: a stop always tears down what the
// starts before it built, and a start never races a teardown.
dispatch_queue_t TapQueue() {
  static dispatch_queue_t queue = dispatch_queue_create("com.babelvoice.process-tap", DISPATCH_QUEUE_SERIAL);
  return queue;
}

struct TapConvertContext {
  const AudioBufferList *input;
  UInt32 bytesPerFrame;
  bool consumed;
};

OSStatus TapFillConverterCallback(
  AudioConverterRef,
  UInt32 *ioNumberDataPackets,
  AudioBufferList *ioData,
  AudioStreamPacketDescription **,
  void *inUserData
) {
  TapConvertContext *ctx = static_cast<TapConvertContext *>(inUserData);
  if (ctx->consumed || !ctx->input || ctx->input->mNumberBuffers == 0) {
    *ioNumberDataPackets = 0;
    // Non-zero tells the converter "no more input right now" without
    // aborting; output frames already produced are still returned.
    return kTapNoMoreInput;
  }
  const UInt32 buffers = std::min(ioData->mNumberBuffers, ctx->input->mNumberBuffers);
  for (UInt32 i = 0; i < buffers; i++) {
    ioData->mBuffers[i] = ctx->input->mBuffers[i];
  }
  ioData->mNumberBuffers = buffers;
  *ioNumberDataPackets = ctx->bytesPerFrame > 0
    ? ctx->input->mBuffers[0].mDataByteSize / ctx->bytesPerFrame
    : 0;
  ctx->consumed = true;
  return noErr;
}

// IO thread. Drops (and counts) samples when the pump falls >2s behind.
void TapRingWrite(TapCapture *tap, const int16_t *src, UInt32 count) {
  const uint64_t writeIdx = tap->ringWrite.load(std::memory_order_relaxed);
  const uint64_t readIdx = tap->ringRead.load(std::memory_order_acquire);
  const uint64_t space = kTapRingCapacity - (writeIdx - readIdx);
  const UInt32 n = static_cast<UInt32>(std::min<uint64_t>(count, space));
  for (UInt32 i = 0; i < n; i++) {
    tap->ring[(writeIdx + i) & kTapRingMask] = src[i];
  }
  tap->ringWrite.store(writeIdx + n, std::memory_order_release);
  if (n < count) tap->overruns.fetch_add(count - n, std::memory_order_relaxed);
}

// IO thread: no allocation, no locks, no ObjC.
void TapConvertInput(TapCapture *tap, const AudioBufferList *input) {
  if (!input || input->mNumberBuffers == 0 || input->mBuffers[0].mDataByteSize == 0) return;
  const UInt32 bytesPerFrame = tap->inputASBD.mBytesPerFrame;
  AudioConverterRef converter = tap->converter.get();
  if (bytesPerFrame == 0 || !converter || tap->scratchFrames == 0) return;
  TapConvertContext ctx{input, bytesPerFrame, false};
  // A cycle larger than the scratch buffer just takes another pass; the
  // input stays valid for the whole IOProc call.
  for (int pass = 0; pass < 16; pass++) {
    UInt32 outFrames = tap->scratchFrames;
    AudioBufferList outList;
    outList.mNumberBuffers = 1;
    outList.mBuffers[0].mNumberChannels = 1;
    outList.mBuffers[0].mDataByteSize = outFrames * sizeof(int16_t);
    outList.mBuffers[0].mData = tap->scratch.data();
    const OSStatus err = AudioConverterFillComplexBuffer(
      converter, TapFillConverterCallback, &ctx, &outFrames, &outList, nullptr);
    if (outFrames > 0) TapRingWrite(tap, tap->scratch.data(), outFrames);
    // kTapNoMoreInput (or a short read) means this cycle's input is used up.
    if (err != noErr || outFrames < tap->scratchFrames) break;
  }
}

OSStatus ProcessTapIOProc(
  AudioObjectID,
  const AudioTimeStamp *,
  const AudioBufferList *inInputData,
  const AudioTimeStamp *,
  AudioBufferList *,
  const AudioTimeStamp *,
  void *clientData
) {
  TapCapture *tap = static_cast<TapCapture *>(clientData);
  // Teardown waits for this counter before freeing anything we touch.
  tap->ioInFlight.fetch_add(1);
  // After a format change the converter would silently pitch-shift; drop
  // audio until JS restarts the capture (it gets onError).
  if (tap->ioEnabled.load() && !tap->formatChanged.load(std::memory_order_relaxed)) {
    TapConvertInput(tap, inInputData);
  }
  tap->ioInFlight.fetch_sub(1);
  return noErr;
}

void TapDrainRing(TapCapture *tap) {
  const uint64_t writeIdx = tap->ringWrite.load(std::memory_order_acquire);
  const uint64_t readIdx = tap->ringRead.load(std::memory_order_relaxed);
  const size_t count = static_cast<size_t>(writeIdx - readIdx);
  if (count == 0) return;
  // Stopped (teardown now runs later, on TapQueue): drop the audio, and don't
  // flip the route status back from "idle".
  if (!tap->sink->accepting.load(std::memory_order_acquire)) {
    tap->ringRead.store(writeIdx, std::memory_order_release);
    return;
  }
  PcmPacketPtr packet = AllocPacket(count * sizeof(int16_t));
  if (!packet) {
    tap->ringRead.store(writeIdx, std::memory_order_release);
    return;
  }
  int16_t *samples = static_cast<int16_t *>(packet->bytes);
  for (size_t i = 0; i < count; i++) {
    samples[i] = tap->ring[(readIdx + i) & kTapRingMask];
  }
  tap->ringRead.store(writeIdx, std::memory_order_release);
  UpdateDiagnostics(ListenDiagnostics(), packet->bytes, packet->length, "process-tap");
  tap->sink->PostPcm(std::move(packet));
}

void TapPumpLoop(TapCapture *tap) {
  NativeDiagnostics &diag = ListenDiagnostics();
  std::unique_lock<std::mutex> lock(tap->pumpMutex);
  while (!tap->pumpStop) {
    tap->pumpCv.wait_for(lock, kTapPumpInterval, [tap] { return tap->pumpStop; });
    lock.unlock();
    TapDrainRing(tap);
    const uint64_t overruns = tap->overruns.exchange(0, std::memory_order_relaxed);
    if (overruns > 0) diag.droppedSamples.fetch_add(overruns, std::memory_order_relaxed);
    lock.lock();
  }
}

bool SameTapInputFormat(const AudioStreamBasicDescription &a, const AudioStreamBasicDescription &b) {
  return a.mSampleRate == b.mSampleRate &&
         a.mChannelsPerFrame == b.mChannelsPerFrame &&
         a.mBytesPerFrame == b.mBytesPerFrame;
}

// Monitor queue. The output device's rate changing mid-capture (e.g. AirPods
// switching profile) changes the tap format under the converter.
void TapCheckFormat(const std::weak_ptr<TapCapture> &weakTap) {
  std::shared_ptr<TapCapture> tap = weakTap.lock();
  if (!tap) return;
  std::lock_guard<std::mutex> lock(tap->monitorMutex);
  if (tap->tornDown || tap->formatChanged.load(std::memory_order_acquire)) return;
  AudioStreamBasicDescription current{};
  if (!ReadInputStreamFormat(tap->aggregate.get(), current) || SameTapInputFormat(current, tap->inputASBD)) return;
  tap->formatChanged.store(true, std::memory_order_release);
  char message[256];
  std::snprintf(
    message,
    sizeof(message),
    "会议应用的音频输出格式已变化（%.0f Hz/%u 声道 → %.0f Hz/%u 声道），请重新开始听模式",
    tap->inputASBD.mSampleRate,
    static_cast<unsigned>(tap->inputASBD.mChannelsPerFrame),
    current.mSampleRate,
    static_cast<unsigned>(current.mChannelsPerFrame));
  tap->sink->PostError(message);
}

// Monitor queue. Helpers come and go (Chrome restarts its audio service, a
// new Meet tab spawns a renderer): retarget the live tap instead of going
// silent. Best effort — a failed update keeps the previous process list.
API_AVAILABLE(macos(14.4))
void TapRefreshProcesses(const std::weak_ptr<TapCapture> &weakTap) {
  std::shared_ptr<TapCapture> tap = weakTap.lock();
  if (!tap) return;
  std::vector<AudioObjectID> current = FindProcessObjectsForBundle(tap->bundleId);
  std::lock_guard<std::mutex> lock(tap->monitorMutex);
  if (tap->tornDown || !tap->description || current.empty() || current == tap->processes) return;
  tap->description.processes = ProcessIdArray(current);
  CFTypeRef descriptionRef = (__bridge CFTypeRef)tap->description;
  AudioObjectPropertyAddress address = {
    kAudioTapPropertyDescription,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain
  };
  if (AudioObjectSetPropertyData(tap->tap.get(), &address, 0, nullptr, sizeof(descriptionRef), &descriptionRef) == noErr) {
    tap->processes = std::move(current);
  }
}

API_AVAILABLE(macos(14.4))
void InstallTapMonitors(const std::shared_ptr<TapCapture> &tap, pid_t mainPid) {
  std::weak_ptr<TapCapture> weakTap = tap;
  std::shared_ptr<CaptureSink> sink = tap->sink;
  const AudioObjectID aggregateID = tap->aggregate.get();

  tap->listeners.Add(
    aggregateID,
    kAudioDevicePropertyDeviceIsAlive,
    kAudioObjectPropertyScopeGlobal,
    ^(UInt32, const AudioObjectPropertyAddress *) {
      if (!DeviceIsAlive(aggregateID)) {
        sink->PostError("进程音频采集设备已失效（Core Audio 可能已重启），请重新开始听模式");
      }
    });
  AudioObjectPropertyListenerBlock onFormat = ^(UInt32, const AudioObjectPropertyAddress *) {
    TapCheckFormat(weakTap);
  };
  tap->listeners.Add(aggregateID, kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal, onFormat);
  tap->listeners.Add(tap->tap.get(), kAudioTapPropertyFormat, kAudioObjectPropertyScopeGlobal, onFormat);
  tap->listeners.Add(
    kAudioObjectSystemObject,
    kAudioHardwarePropertyProcessObjectList,
    kAudioObjectPropertyScopeGlobal,
    ^(UInt32, const AudioObjectPropertyAddress *) { TapRefreshProcesses(weakTap); });

  // The target quitting otherwise just looks like silence.
  if (mainPid > 0) {
    dispatch_source_t exitSource =
      dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC, static_cast<uintptr_t>(mainPid), DISPATCH_PROC_EXIT, MonitorQueue());
    if (exitSource) {
      dispatch_source_set_event_handler(exitSource, ^{
        sink->PostError("目标会议应用已退出");
      });
      dispatch_resume(exitSource);
      tap->exitSource.Adopt(exitSource);
    }
  }
}

// Tap queue. Idempotent. Once this returns no IOProc, pump or monitor block
// runs for `tap`, and nothing but leaked memory refers to it. Never touches
// the TSFNs: BeginStop already cuts the producers off, and releasing them is
// the JS thread's job (StopProcessTap, or the failed start's settle hook).
void DestroyTapNative(const std::shared_ptr<TapCapture> &tap) {
  if (tap->sink) tap->sink->BeginStop();
  {
    std::lock_guard<std::mutex> lock(tap->monitorMutex);
    tap->tornDown = true;
  }
  tap->listeners.Clear();
  tap->exitSource.Reset();

  tap->ioEnabled.store(false);
  tap->ioProc.Reset();
  // AudioDeviceStop off the IO thread waits for the current cycle; the
  // in-flight counter makes that a guarantee rather than an assumption.
  bool drained = tap->ioInFlight.load() == 0;
  for (int i = 0; i < 1000 && !drained; i++) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
    drained = tap->ioInFlight.load() == 0;
  }

  if (tap->pump.joinable()) {
    {
      std::lock_guard<std::mutex> lock(tap->pumpMutex);
      tap->pumpStop = true;
    }
    tap->pumpCv.notify_all();
    tap->pump.join();
  }

  tap->aggregate.Reset();
  tap->tap.Reset();
  if (drained) {
    tap->converter.Reset();
  } else {
    std::vector<std::shared_ptr<TapCapture>> &leaked = Slot().leaked;
    if (std::find(leaked.begin(), leaked.end(), tap) == leaked.end()) leaked.push_back(tap);
  }
}

// JS thread. JS callbacks stop right away; the HAL teardown is queued behind
// any start still building this tap, and `stopSettler` (optional) resolves
// once it ran — or after a timeout, so a wedged coreaudiod can't hang the
// caller. `releaseJs` is false on the env-teardown path, where Node frees the
// TSFNs itself; the queued teardown never touches them either way.
void StopProcessTap(bool releaseJs, const std::shared_ptr<PromiseSettler> &stopSettler = nullptr) {
  TapSlot &slot = Slot();
  if (!slot.current) {
    if (stopSettler) Settle(stopSettler, true, "");
    return;
  }
  std::shared_ptr<TapCapture> tap = std::move(slot.current);
  tap->stopRequested.store(true, std::memory_order_release);
  tap->sink->BeginStop();
  // No-op when the start already settled.
  if (tap->startSettler) Settle(tap->startSettler, false, "process audio capture was stopped before it started");
  if (releaseJs) {
    tap->sink->Release();
  } else {
    tap->sink->Detach();
  }
  SetRouteStatus(ListenDiagnostics(), "idle");
  // Blocks capture C++ references by reference: own a copy.
  std::shared_ptr<PromiseSettler> done = stopSettler;
  dispatch_async(TapQueue(), ^{
    @autoreleasepool {
      DestroyTapNative(tap);
    }
    if (done) Settle(done, true, "");
  });
  if (done) {
    dispatch_after(
      dispatch_time(DISPATCH_TIME_NOW, kTapStopTimeoutNs),
      dispatch_get_global_queue(QOS_CLASS_UTILITY, 0),
      ^{ Settle(done, true, ""); });
  }
}

void StopTapIfCurrent(CaptureSink *sink) {
  TapSlot &slot = Slot();
  if (slot.current && slot.current->sink.get() == sink) StopProcessTap(false);
}

// Tap queue. Builds the whole pipeline for `tap`. On failure `error` says
// why and the caller tears down whatever got built (DestroyTapNative).
API_AVAILABLE(macos(14.4))
bool BuildProcessTap(const std::shared_ptr<TapCapture> &tap, Float64 sampleRate, std::string &error) {
  NSString *bundleIdNs = [NSString stringWithUTF8String:tap->bundleId.c_str()];
  const std::vector<AudioObjectID> processes = FindProcessObjectsForBundle(tap->bundleId);
  if (processes.empty()) {
    // A process only gets a Core Audio process object once it touches audio,
    // so "running but silent so far" also lands here.
    error = RunningAppPid(bundleIdNs) > 0
      ? "目标会议应用还没有输出过声音：请先在该应用里加入会议（确保正在播放声音），再开启听模式。"
      : "目标会议应用未运行：请先打开它并加入会议（需要正在播放声音），再开启听模式。";
    return false;
  }
  tap->processes = processes;

  // Mono mixdown so we don't fight stereo formats; private tap so it doesn't
  // show up as a public device; unmuted so the original app keeps playing.
  CATapDescription *desc = [[CATapDescription alloc] initMonoMixdownOfProcesses:ProcessIdArray(processes)];
  desc.muteBehavior = CATapUnmuted;
  desc.exclusive = NO;
  desc.privateTap = YES;
  desc.name = @"BabelVoice Process Tap";
  tap->description = desc;

  AudioObjectID tapID = kAudioObjectUnknown;
  OSStatus err = AudioHardwareCreateProcessTap(desc, &tapID);
  if (err != noErr || tapID == kAudioObjectUnknown) {
    error = "AudioHardwareCreateProcessTap failed";
    return false;
  }
  tap->tap.Adopt(tapID);

  // Aggregate device wrapping the tap. AutoStart so the tap only runs while
  // the device's IO is active.
  NSString *aggUID = [[NSUUID UUID] UUIDString];
  NSDictionary *aggDesc = @{
    @(kAudioAggregateDeviceUIDKey): aggUID,
    @(kAudioAggregateDeviceNameKey): @"BabelVoice Process Tap Aggregate",
    @(kAudioAggregateDeviceIsPrivateKey): @YES,
    @(kAudioAggregateDeviceIsStackedKey): @NO,
    @(kAudioAggregateDeviceTapAutoStartKey): @YES,
    @(kAudioAggregateDeviceTapListKey): @[@{
      @(kAudioSubTapUIDKey): desc.UUID.UUIDString
    }]
  };
  AudioObjectID aggID = kAudioObjectUnknown;
  err = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)aggDesc, &aggID);
  if (err != noErr || aggID == kAudioObjectUnknown) {
    error = "AudioHardwareCreateAggregateDevice failed";
    return false;
  }
  tap->aggregate.Adopt(aggID);

  // The aggregate's input format is what the IOProc will hand us — typically
  // 48k float32 from the tap, but we don't assume that.
  if (!ReadInputStreamFormat(aggID, tap->inputASBD) || tap->inputASBD.mBytesPerFrame == 0) {
    error = "Aggregate device input format query failed";
    return false;
  }

  // Target format: mono Int16 LinearPCM at the requested rate, packed,
  // native byte order.
  AudioStreamBasicDescription outputASBD{};
  outputASBD.mSampleRate = sampleRate;
  outputASBD.mFormatID = kAudioFormatLinearPCM;
  outputASBD.mFormatFlags = kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked;
  outputASBD.mFramesPerPacket = 1;
  outputASBD.mChannelsPerFrame = 1;
  outputASBD.mBitsPerChannel = 16;
  outputASBD.mBytesPerFrame = 2;
  outputASBD.mBytesPerPacket = 2;

  AudioConverterRef converter = nullptr;
  err = AudioConverterNew(&tap->inputASBD, &outputASBD, &converter);
  if (err != noErr || !converter) {
    error = "AudioConverterNew failed";
    return false;
  }
  tap->converter.Adopt(converter);

  // Converter output for the largest cycle the device may deliver, allocated
  // here so the IOProc never has to.
  const UInt32 maxInputFrames = MaxIoBufferFrames(aggID);
  tap->scratchFrames = static_cast<UInt32>(
    std::ceil(static_cast<double>(maxInputFrames) * outputASBD.mSampleRate / tap->inputASBD.mSampleRate)) + 64;
  tap->scratch.assign(tap->scratchFrames, 0);

  AudioDeviceIOProcID ioProcID = nullptr;
  err = AudioDeviceCreateIOProcID(aggID, ProcessTapIOProc, tap.get(), &ioProcID);
  if (err != noErr || !ioProcID) {
    error = "AudioDeviceCreateIOProcID failed";
    return false;
  }
  tap->ioProc.Adopt(aggID, ioProcID);

  tap->pump = std::thread(TapPumpLoop, tap.get());
  InstallTapMonitors(tap, RunningAppPid(bundleIdNs));

  tap->ioEnabled.store(true);
  err = AudioDeviceStart(aggID, ioProcID);
  if (err != noErr) {
    error = "AudioDeviceStart failed";
    return false;
  }

  return true;
}

// JS thread. -> Promise<void>: resolves once the tap is capturing, rejects
// (slot already freed) if building it failed or JS stopped it first. The HAL
// work runs on TapQueue; see there.
API_AVAILABLE(macos(14.4))
napi_value StartProcessTap(
  napi_env env, const std::string &bundleId, napi_value onPcm, napi_value onError, Float64 sampleRate) {
  auto tap = std::make_shared<TapCapture>();
  tap->bundleId = bundleId;
  tap->sink = CreateCaptureSink(env, onPcm, onError, "BabelVoiceProcessTap", StopTapIfCurrent);
  if (!tap->sink) {
    Throw(env, "failed to create capture callback");
    return nullptr;
  }
  napi_value promise;
  std::shared_ptr<PromiseSettler> settler = CreateSettler(env, "BabelVoiceProcessTapStart", &promise);
  if (!settler) {
    tap->sink->Release();
    Throw(env, "failed to create capture promise");
    return nullptr;
  }
  // A failed start leaves nothing for JS to stop: free the slot and the JS
  // callbacks here, on the JS thread. Not current any more means JS already
  // stopped it, which released the callbacks. weak_ptr: the tap owns the
  // settler.
  std::weak_ptr<TapCapture> weakTap = tap;
  settler->onSettledJs = [weakTap](bool ok) {
    std::shared_ptr<TapCapture> settled = weakTap.lock();
    TapSlot &current = Slot();
    if (!settled || current.current != settled) return;
    if (ok) {
      SetRouteStatus(ListenDiagnostics(), "process-tap");
      return;
    }
    current.current.reset();
    SetRouteStatus(ListenDiagnostics(), "idle");
    settled->sink->Release();
  };
  tap->startSettler = settler;
  Slot().current = tap;
  SetRouteStatus(ListenDiagnostics(), "starting");

  dispatch_async(TapQueue(), ^{
    // Stopped before we got here: the stop already settled the start.
    if (tap->stopRequested.load(std::memory_order_acquire)) return;
    std::string error;
    bool built = false;
    @autoreleasepool {
      built = BuildProcessTap(tap, sampleRate, error);
      if (!built) DestroyTapNative(tap);
    }
    if (!built) {
      SetLastError(ListenDiagnostics(), error.c_str());
      Settle(tap->startSettler, false, error);
      return;
    }
    // A stop that raced the build already settled the start (this is then a
    // no-op) and its teardown is queued right behind us.
    Settle(tap->startSettler, true, "");
  });
  return promise;
}

}  // namespace

napi_value ListAudioCapableApplications(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value arr;
  napi_create_array(env, &arr);
  uint32_t index = 0;
  NSArray<NSRunningApplication *> *apps =
    [NSWorkspace.sharedWorkspace runningApplications];
  for (NSRunningApplication *app in apps) {
    // Only show foreground apps the user would recognize. Background daemons
    // (activationPolicy != regular) are noise even when they output audio.
    if (app.activationPolicy != NSApplicationActivationPolicyRegular) continue;
    NSString *bundleId = app.bundleIdentifier;
    if (bundleId.length == 0) continue;
    NSString *displayName = app.localizedName ?: bundleId;
    napi_value entry;
    napi_create_object(env, &entry);
    SetNamed(env, entry, "pid", MakeNumber(env, app.processIdentifier));
    SetNamed(env, entry, "bundleId", MakeString(env, bundleId.UTF8String));
    SetNamed(env, entry, "name", MakeString(env, displayName.UTF8String));
    napi_set_element(env, arr, index++, entry);
  }
  return arr;
}

// startProcessAudioCapture(bundleId, onPcm, onError?, sampleRate?) -> Promise<void>
napi_value StartProcessAudioCapture(napi_env env, napi_callback_info info) {
  if (@available(macOS 14.4, *)) {
    // fall through
  } else {
    Throw(env, "Process Tap requires macOS 14.4 or newer");
    return nullptr;
  }
  if (Slot().current) {
    Throw(env, "process audio capture is already running");
    return nullptr;
  }

  size_t argc = 4;
  napi_value args[4];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 2) {
    Throw(env, "startProcessAudioCapture requires (bundleId, callback)");
    return nullptr;
  }
  const std::string bundleId = StringArg(env, args[0]);
  napi_valuetype cbType;
  napi_typeof(env, args[1], &cbType);
  if (cbType != napi_function) {
    Throw(env, "startProcessAudioCapture callback must be a function");
    return nullptr;
  }
  napi_value onError = OptionalFunctionArg(env, args, argc, 2);
  Float64 sampleRate = kDefaultCaptureSampleRate;
  if (!CaptureSampleRateArg(env, args, argc, 3, sampleRate)) return nullptr;

  if (@available(macOS 14.4, *)) {
    return StartProcessTap(env, bundleId, args[1], onError, sampleRate);
  }
  // Unreachable on macOS < 14.4 — already returned above.
  Throw(env, "Process Tap requires macOS 14.4 or newer");
  return nullptr;
}

// stopProcessAudioCapture() -> Promise<void>. JS callbacks stop immediately;
// resolves once the tap and its aggregate device are gone (or after a
// timeout).
napi_value StopProcessAudioCapture(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value promise;
  std::shared_ptr<PromiseSettler> settler = CreateSettler(env, "BabelVoiceProcessTapStop", &promise);
  if (!settler) {
    Throw(env, "failed to create stop promise");
    return nullptr;
  }
  StopProcessTap(true, settler);
  return promise;
}

void StopProcessTapForTeardown() {
  StopProcessTap(false);
}

}  // namespace babelvoice
