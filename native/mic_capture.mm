#include "mic_capture.h"

#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <CoreAudio/CoreAudio.h>
#import <Foundation/Foundation.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "capture_sink.h"
#include "devices.h"
#include "diagnostics.h"
#include "napi_util.h"
#include "pcm_resampler.h"
#include "scoped_cf.h"
#include "tts_output.h"

namespace babelvoice {

namespace {

// ---------------------------------------------------------------------------
// One microphone capture, fanned out to every consumer.
//
// A single AudioQueue (a "run") records at kMicHubSampleRate, the highest
// rate anyone takes. Consumers attach and detach without touching it:
//   - JS PCM consumers (a speak session) get their own copy, resampled to
//     their rate when it differs (PcmResampler, preallocated, never
//     allocates on the AudioQueue thread);
//   - consumers without onPcm (mic passthrough) only hold the capture open
//     and receive onError;
//   - the passthrough tee writes the hub-rate PCM into the TTS queue while
//     the flag is on and the TTS unit runs at the hub rate.
// The queue starts with the first consumer, stops with the last one, and is
// rebuilt only when a consumer asks for another device or the run failed.
//
// Threads: the JS thread owns the hub. The AudioQueue callback reads the
// PCM slots (atomics) and the consumers they point at. Monitor-queue blocks
// reach a run only through its shared_ptr<MicRunShared>.
// ---------------------------------------------------------------------------

// 24 kHz: the passthrough tee needs it and it is the highest capture rate a
// TranslationClient takes; 16 kHz consumers are resampled from it.
constexpr Float64 kMicHubSampleRate = 24000;
constexpr size_t kMaxPcmConsumers = 4;
// 4 x 40ms instead of 3 x 100ms: lower passthrough latency; JS re-aggregates
// the smaller chunks for the uplink.
constexpr UInt32 kMicBufferCount = 4;
constexpr UInt32 kMicBuffersPerSecond = 25;  // 40ms each
constexpr UInt32 kMicBufferFrames = static_cast<UInt32>(kMicHubSampleRate) / kMicBuffersPerSecond;

// The queue going idle on its own (device gone, coreaudiod restart) used to
// look like a running capture that simply never delivered audio. Wait a beat
// before calling it a failure: an unpinned queue may bounce while following a
// default-device switch.
constexpr int64_t kMicIdleGraceNs = 750 * NSEC_PER_MSEC;

// How long a detach waits for an in-flight AudioQueue callback (one chunk's
// worth of dispatch, ~0.2 ms) before giving the consumer up as leaked.
constexpr auto kSlotQuiesceTimeout = std::chrono::seconds(1);

// Owns one input AudioQueue and (optionally) its IsRunning listener. Reset()
// is synchronous: once AudioQueueDispose(…, true) returns no input callback
// or property listener is running or will run.
class ScopedAudioQueue {
 public:
  ScopedAudioQueue() = default;
  ~ScopedAudioQueue() { Reset(); }
  ScopedAudioQueue(const ScopedAudioQueue &) = delete;
  ScopedAudioQueue &operator=(const ScopedAudioQueue &) = delete;

  AudioQueueRef get() const { return queue_; }
  explicit operator bool() const { return queue_ != nullptr; }
  // Takes ownership of a queue AudioQueueNewInput created.
  void Adopt(AudioQueueRef queue) {
    Reset();
    queue_ = queue;
  }
  // Reset() removes the listener before stopping the queue, so stopping it
  // ourselves never calls back into a run being torn down.
  void AddPropertyListener(AudioQueuePropertyID id, AudioQueuePropertyListenerProc proc, void *userData) {
    if (!queue_ || listenerProc_) return;
    AudioQueueAddPropertyListener(queue_, id, proc, userData);
    listenerId_ = id;
    listenerProc_ = proc;
    listenerUserData_ = userData;
  }
  void Reset() {
    if (!queue_) return;
    if (listenerProc_) AudioQueueRemovePropertyListener(queue_, listenerId_, listenerProc_, listenerUserData_);
    AudioQueueStop(queue_, true);
    AudioQueueDispose(queue_, true);
    queue_ = nullptr;
    listenerProc_ = nullptr;
    listenerUserData_ = nullptr;
  }

 private:
  AudioQueueRef queue_ = nullptr;
  AudioQueuePropertyID listenerId_ = 0;
  AudioQueuePropertyListenerProc listenerProc_ = nullptr;
  void *listenerUserData_ = nullptr;
};

// One startMicrophoneCapture() call. Immutable once attached except
// `failed`; `resampler` is used only by the AudioQueue callback while the
// consumer sits in a PCM slot.
struct MicConsumer {
  uint32_t id = 0;
  std::shared_ptr<CaptureSink> sink;
  bool deliverPcm = false;
  Float64 sampleRate = kMicHubSampleRate;  // of the PCM handed to JS
  std::unique_ptr<PcmResampler> resampler;  // null: hub rate, passed through
  // The run this consumer was on failed: it got onError and receives nothing
  // more. Set under MicRunShared::mutex.
  std::atomic_bool failed{false};
};

// The part of a run that monitor-queue blocks may still hold after the run
// is gone. `mutex` orders failure against attach / stop / tee enable.
struct MicRunShared {
  std::mutex mutex;
  bool stopped = false;                                  // guarded by mutex
  bool failed = false;                                   // guarded by mutex
  std::string failure;                                   // guarded by mutex
  std::vector<std::shared_ptr<MicConsumer>> consumers;   // guarded by mutex
  // Lock-free mirror of `failed` for the AudioQueue callback.
  std::atomic_bool failedHint{false};

  // Any thread. The first failure of a live run turns the passthrough tee
  // off right here — a dead or looping mic must not keep feeding the virtual
  // device until JS gets round to it (a loopback would feed itself, a dead
  // device would feed the meeting silence) — and tells every consumer once.
  // A block outliving its run finds it stopped and does nothing, so it can't
  // touch the tee a newer run now owns.
  void Fail(const char *message) {
    std::lock_guard<std::mutex> lock(mutex);
    if (stopped || failed) return;
    failed = true;
    failure = message ? message : "";
    failedHint.store(true, std::memory_order_release);
    SetMicPassthroughFlag(false);
    for (const std::shared_ptr<MicConsumer> &consumer : consumers) FailConsumerLocked(*consumer);
  }

  // JS thread. A run that failed between the caller's health check and here
  // still reports to the newcomer.
  void Add(const std::shared_ptr<MicConsumer> &consumer) {
    std::lock_guard<std::mutex> lock(mutex);
    consumers.push_back(consumer);
    if (failed) FailConsumerLocked(*consumer);
  }

  // JS thread.
  void Remove(const MicConsumer *consumer) {
    std::lock_guard<std::mutex> lock(mutex);
    consumers.erase(
      std::remove_if(consumers.begin(), consumers.end(),
                     [consumer](const std::shared_ptr<MicConsumer> &c) { return c.get() == consumer; }),
      consumers.end());
  }

  // JS thread. No failure is reported once this returns; hands back the
  // consumers that are still healthy.
  std::vector<std::shared_ptr<MicConsumer>> Stop() {
    std::lock_guard<std::mutex> lock(mutex);
    stopped = true;
    std::vector<std::shared_ptr<MicConsumer>> healthy;
    for (const std::shared_ptr<MicConsumer> &consumer : consumers) {
      if (!consumer->failed.load(std::memory_order_acquire)) healthy.push_back(consumer);
    }
    consumers.clear();
    return healthy;
  }

  bool Healthy() {
    std::lock_guard<std::mutex> lock(mutex);
    return !stopped && !failed;
  }

  // Runs `fn` under the lock iff the run is live and hasn't failed, so
  // nothing done by `fn` can land after (and undo) a Fail.
  template <typename Fn>
  bool IfHealthy(Fn &&fn) {
    std::lock_guard<std::mutex> lock(mutex);
    if (stopped || failed) return false;
    fn();
    return true;
  }

 private:
  void FailConsumerLocked(MicConsumer &consumer) {
    if (consumer.failed.exchange(true, std::memory_order_acq_rel)) return;
    consumer.sink->Fail(failure.c_str(), [] {});
  }
};

struct MicHub;

// One AudioQueue lifetime.
struct MicRun {
  MicHub *hub = nullptr;
  NativeDiagnostics *diag = &MicDiagnostics();
  std::string deviceUid;  // as requested; empty = follow the system default
  std::shared_ptr<MicRunShared> shared = std::make_shared<MicRunShared>();
  // False once we decided to stop: the input callback stops re-enqueueing
  // and the queue going idle is no longer "unexpected".
  std::atomic_bool running{false};
  // Last kAudioQueueProperty_IsRunning value, shared with delayed checks.
  std::shared_ptr<std::atomic_bool> queueRunning = std::make_shared<std::atomic_bool>(false);
  std::shared_ptr<std::atomic<uint64_t>> idleEpoch = std::make_shared<std::atomic<uint64_t>>(0);
  ListenerSet listeners;
  // Declared last, so destroyed first: no callback outlives the members it
  // touches even on a path that skips DestroyRun.
  ScopedAudioQueue queue;
};

struct MicHub {
  MicHub() {
    for (std::atomic<MicConsumer *> &slot : pcmSlots) slot.store(nullptr, std::memory_order_relaxed);
  }

  // Read by the AudioQueue callback. A slot is written only by the JS
  // thread: set after the consumer is fully built, cleared before it is
  // destroyed (see VacateSlot).
  std::array<std::atomic<MicConsumer *>, kMaxPcmConsumers> pcmSlots;
  std::atomic<uint32_t> dispatchesInFlight{0};

  // JS thread only.
  std::unique_ptr<MicRun> run;
  std::vector<std::shared_ptr<MicConsumer>> consumers;
  uint32_t nextConsumerId = 1;
  uint64_t queueStarts = 0;
  // Consumers whose slot never quiesced (shouldn't happen); kept alive
  // rather than risk a use-after-free in the callback.
  std::vector<std::shared_ptr<MicConsumer>> leaked;
};

MicHub &Hub() {
  static MicHub *const hub = new MicHub();
  return *hub;
}

// AudioQueue thread: atomics, the preallocated resampler, and the same
// per-chunk PostPcm / tee hand-off the single-consumer capture had.
void DispatchMicPcm(MicHub &hub, const int16_t *samples, UInt32 frames) {
  // Paired with VacateSlot: either it sees this count, or this sees its
  // cleared slot (both seq_cst).
  hub.dispatchesInFlight.fetch_add(1, std::memory_order_seq_cst);
  for (std::atomic<MicConsumer *> &slot : hub.pcmSlots) {
    MicConsumer *consumer = slot.load(std::memory_order_seq_cst);
    if (!consumer || consumer->failed.load(std::memory_order_acquire)) continue;
    if (consumer->resampler) {
      const uint32_t converted = consumer->resampler->Convert(samples, frames);
      if (converted > 0) {
        consumer->sink->PostPcm(CopyPacket(consumer->resampler->output(), converted * sizeof(int16_t)));
      }
    } else {
      consumer->sink->PostPcm(CopyPacket(samples, frames * sizeof(int16_t)));
    }
  }
  hub.dispatchesInFlight.fetch_sub(1, std::memory_order_seq_cst);
}

void MicInputCallback(
  void *userData,
  AudioQueueRef queue,
  AudioQueueBufferRef buffer,
  const AudioTimeStamp *,
  UInt32,
  const AudioStreamPacketDescription *
) {
  // `run` outlives every callback: it's freed only after AudioQueueDispose(sync).
  MicRun *run = static_cast<MicRun *>(userData);
  if (!run->running.load(std::memory_order_acquire)) return;
  const UInt32 frames = buffer->mAudioDataByteSize / sizeof(int16_t);
  if (frames > 0) {
    const int16_t *samples = static_cast<const int16_t *>(buffer->mAudioData);
    UpdateDiagnostics(*run->diag, samples, frames * sizeof(int16_t), "capturing");
    if (!run->shared->failedHint.load(std::memory_order_acquire)) {
      DispatchMicPcm(*run->hub, samples, frames);
      // Mic passthrough: while no translation session runs, the meeting
      // peer still hears the speaker. The raw mic PCM goes into the same
      // TTS queue/ring/AudioUnit pipeline translated audio uses, so the
      // virtual loopback device stays continuously fed. The coordinator
      // turns the tee off before a speak session plays TTS, so the two never
      // double-feed; the TTS side drops it unless its unit runs at our rate.
      if (MicPassthroughEnabled()) TeeMicToTtsQueue(samples, frames, kMicHubSampleRate);
    }
  }
  AudioQueueEnqueueBuffer(queue, buffer, 0, nullptr);
}

void MicIsRunningChanged(void *userData, AudioQueueRef queue, AudioQueuePropertyID) {
  MicRun *run = static_cast<MicRun *>(userData);
  UInt32 isRunning = 1;
  UInt32 size = sizeof(isRunning);
  if (AudioQueueGetProperty(queue, kAudioQueueProperty_IsRunning, &isRunning, &size) != noErr) return;
  run->queueRunning->store(isRunning != 0, std::memory_order_release);
  if (isRunning || !run->running.load(std::memory_order_acquire)) return;

  // Delayed re-check through shared state only — `run` may be gone by then.
  std::shared_ptr<MicRunShared> shared = run->shared;
  std::shared_ptr<std::atomic_bool> queueRunning = run->queueRunning;
  std::shared_ptr<std::atomic<uint64_t>> idleEpoch = run->idleEpoch;
  const uint64_t epoch = idleEpoch->fetch_add(1, std::memory_order_acq_rel) + 1;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, kMicIdleGraceNs), MonitorQueue(), ^{
    if (idleEpoch->load(std::memory_order_acquire) != epoch) return;
    if (queueRunning->load(std::memory_order_acquire)) return;
    shared->Fail("麦克风采集意外停止（输入设备可能已断开）");
  });
}

// JS thread. Synchronously stops `run`; afterwards no callback for it runs
// and no failure is reported for it.
void DestroyRun(std::unique_ptr<MicRun> run) {
  if (!run) return;
  run->running.store(false, std::memory_order_release);
  run->shared->Stop();
  run->listeners.Clear();
  run->queue.Reset();
}

// JS thread. Recording the virtual loopback itself would feed our own output
// straight back in: passthrough would loop and speak mode would translate its
// own TTS. Refused whether it is the system default (unpinned queue) or the
// device the caller picked. Empty when the input is acceptable.
std::string VirtualInputRefusal(const std::string &deviceUid) {
  const AudioDeviceID inputDevice =
    deviceUid.empty() ? DefaultDevice(kAudioHardwarePropertyDefaultInputDevice) : DeviceForUID(deviceUid);
  NSString *inputName = inputDevice == kAudioObjectUnknown
    ? nil
    : CopyStringProperty(inputDevice, kAudioObjectPropertyName);
  if (!IsVirtualName(inputName, kDefaultVirtualPattern)) return {};
  return std::string(deviceUid.empty() ? "系统默认输入设备是虚拟声卡「" : "所选的输入设备是虚拟声卡「") +
         inputName.UTF8String +
         "」，直接采集会把翻译输出回录成麦克风输入。请在 BabelVoice 设置中选择真实的麦克风。";
}

// JS thread. Builds and starts a run on `deviceUid`; nullptr + `error` on
// failure (nothing left running).
std::unique_ptr<MicRun> StartRun(MicHub &hub, const std::string &deviceUid, std::string &error) {
  auto run = std::make_unique<MicRun>();
  run->hub = &hub;
  run->deviceUid = deviceUid;
  // Stopped (so a listener that already fired can't fail it) and disposed.
  const auto fail = [&run, &error](const char *message) -> std::unique_ptr<MicRun> {
    error = message;
    DestroyRun(std::move(run));
    return nullptr;
  };

  AudioStreamBasicDescription asbd{};
  asbd.mSampleRate = kMicHubSampleRate;
  asbd.mFormatID = kAudioFormatLinearPCM;
  asbd.mFormatFlags = kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked;
  asbd.mBytesPerPacket = 2;
  asbd.mFramesPerPacket = 1;
  asbd.mBytesPerFrame = 2;
  asbd.mChannelsPerFrame = 1;
  asbd.mBitsPerChannel = 16;

  AudioQueueRef queue = nullptr;
  OSStatus status = AudioQueueNewInput(&asbd, MicInputCallback, run.get(), nullptr, nullptr, 0, &queue);
  if (status != noErr || !queue) return fail("AudioQueueNewInput failed");
  run->queue.Adopt(queue);
  hub.queueStarts++;

  // Pin to a specific input device when the caller supplied a UID. Empty
  // means "default input device" — the queue's default.
  AudioDeviceID pinnedDevice = kAudioObjectUnknown;
  if (!deviceUid.empty()) {
    pinnedDevice = DeviceForUID(deviceUid);
    ScopedCFRef<CFStringRef> uidRef(CFStringCreateWithCString(nullptr, deviceUid.c_str(), kCFStringEncodingUTF8));
    CFStringRef uidValue = uidRef.get();
    OSStatus pinStatus = AudioQueueSetProperty(
      run->queue.get(), kAudioQueueProperty_CurrentDevice, &uidValue, sizeof(uidValue));
    if (pinStatus != noErr) {
      char buf[256];
      snprintf(buf, sizeof(buf),
        "AudioQueueSetProperty(CurrentDevice='%s') failed: %d",
        deviceUid.c_str(), static_cast<int>(pinStatus));
      return fail(buf);
    }
  }

  const UInt32 micBufferBytes = kMicBufferFrames * sizeof(int16_t);
  for (UInt32 i = 0; i < kMicBufferCount; i++) {
    AudioQueueBufferRef buffer = nullptr;
    status = AudioQueueAllocateBuffer(run->queue.get(), micBufferBytes, &buffer);
    if (status != noErr || !buffer) return fail("AudioQueueAllocateBuffer(mic) failed");
    AudioQueueEnqueueBuffer(run->queue.get(), buffer, 0, nullptr);
  }

  run->queue.AddPropertyListener(kAudioQueueProperty_IsRunning, MicIsRunningChanged, run.get());
  std::shared_ptr<MicRunShared> shared = run->shared;
  if (pinnedDevice != kAudioObjectUnknown) {
    // A pinned device that gets unplugged leaves the queue "running" with no
    // data, so watch the device itself.
    run->listeners.Add(
      pinnedDevice,
      kAudioDevicePropertyDeviceIsAlive,
      kAudioObjectPropertyScopeGlobal,
      ^(UInt32, const AudioObjectPropertyAddress *) {
        if (!DeviceIsAlive(pinnedDevice)) shared->Fail("麦克风设备已断开");
      });
  } else {
    // An unpinned queue follows the system default input; if that switches
    // to the virtual loopback mid-capture we'd start looping.
    run->listeners.Add(
      kAudioObjectSystemObject,
      kAudioHardwarePropertyDefaultInputDevice,
      kAudioObjectPropertyScopeGlobal,
      ^(UInt32, const AudioObjectPropertyAddress *) {
        const AudioDeviceID device = DefaultDevice(kAudioHardwarePropertyDefaultInputDevice);
        if (device == kAudioObjectUnknown) return;
        if (IsVirtualName(CopyStringProperty(device, kAudioObjectPropertyName), kDefaultVirtualPattern)) {
          shared->Fail("系统默认输入设备被切换成了虚拟声卡，继续采集会形成回环，请改用真实的麦克风");
        }
      });
  }

  run->running.store(true, std::memory_order_release);
  status = AudioQueueStart(run->queue.get(), nullptr);
  if (status != noErr) return fail("AudioQueueStart(mic) failed");
  SetRouteStatus(*run->diag, "capturing");
  return run;
}

// JS thread. Rebuilds the run on `deviceUid` (another device was asked for,
// or the current run failed), keeping its healthy consumers attached. On
// failure those consumers get onError — their capture is gone.
bool RestartRun(MicHub &hub, const std::string &deviceUid, std::string &error) {
  std::unique_ptr<MicRun> old = std::move(hub.run);
  std::vector<std::shared_ptr<MicConsumer>> carried = old->shared->Stop();
  DestroyRun(std::move(old));
  hub.run = StartRun(hub, deviceUid, error);
  if (!hub.run) {
    const std::string message = "麦克风采集重启失败：" + error;
    for (const std::shared_ptr<MicConsumer> &consumer : carried) {
      if (consumer->failed.exchange(true, std::memory_order_acq_rel)) continue;
      consumer->sink->Fail(message.c_str(), [] {});
    }
    SetMicPassthroughFlag(false);
    SetRouteStatus(MicDiagnostics(), "idle");
    return false;
  }
  for (const std::shared_ptr<MicConsumer> &consumer : carried) hub.run->shared->Add(consumer);
  return true;
}

// JS thread. Takes `consumer` out of the PCM fan-out; true once the
// AudioQueue callback is guaranteed not to touch it any more.
bool VacateSlot(MicHub &hub, MicConsumer *consumer) {
  for (std::atomic<MicConsumer *> &slot : hub.pcmSlots) {
    MicConsumer *expected = consumer;
    if (slot.compare_exchange_strong(expected, nullptr, std::memory_order_seq_cst)) break;
  }
  // A dispatch that loaded the pointer before the store above is counted in
  // dispatchesInFlight (seq_cst on both sides); one that starts later sees
  // the empty slot. Dispatches are ~0.2 ms, 40 ms apart.
  const auto deadline = std::chrono::steady_clock::now() + kSlotQuiesceTimeout;
  while (hub.dispatchesInFlight.load(std::memory_order_seq_cst) != 0) {
    if (std::chrono::steady_clock::now() >= deadline) return false;
    std::this_thread::sleep_for(std::chrono::microseconds(100));
  }
  return true;
}

// JS thread. Stops the shared capture; passthrough goes with it (the source
// of audio is gone — the coordinator re-enables the tee when it next
// engages).
void StopRun(MicHub &hub) {
  SetMicPassthroughFlag(false);
  if (!hub.run) return;
  DestroyRun(std::move(hub.run));
  SetRouteStatus(MicDiagnostics(), "idle");
}

// JS thread. `releaseJs` is false on the env-teardown path, where Node frees
// the TSFNs itself. The last consumer out stops the queue.
void DetachConsumer(MicHub &hub, const std::shared_ptr<MicConsumer> &consumer, bool releaseJs) {
  hub.consumers.erase(std::remove(hub.consumers.begin(), hub.consumers.end(), consumer), hub.consumers.end());
  // Nothing reaches JS from here on.
  consumer->sink->BeginStop();
  if (hub.run) hub.run->shared->Remove(consumer.get());
  if (consumer->deliverPcm && !VacateSlot(hub, consumer.get())) hub.leaked.push_back(consumer);
  if (hub.consumers.empty()) StopRun(hub);
  if (releaseJs) {
    consumer->sink->Release();
  } else {
    consumer->sink->Detach();
  }
}

// JS thread. Every consumer and the queue.
void StopAll(MicHub &hub, bool releaseJs) {
  SetMicPassthroughFlag(false);
  std::vector<std::shared_ptr<MicConsumer>> consumers = std::move(hub.consumers);
  hub.consumers.clear();
  for (const std::shared_ptr<MicConsumer> &consumer : consumers) consumer->sink->BeginStop();
  // Queue first: once it is disposed no callback runs, so the slots can be
  // cleared without waiting.
  StopRun(hub);
  for (std::atomic<MicConsumer *> &slot : hub.pcmSlots) slot.store(nullptr, std::memory_order_seq_cst);
  for (const std::shared_ptr<MicConsumer> &consumer : consumers) {
    if (releaseJs) {
      consumer->sink->Release();
    } else {
      consumer->sink->Detach();
    }
  }
}

std::shared_ptr<MicConsumer> FindConsumer(MicHub &hub, uint32_t id) {
  for (const std::shared_ptr<MicConsumer> &consumer : hub.consumers) {
    if (consumer->id == id) return consumer;
  }
  return nullptr;
}

// TSFN finalizer (JS thread, env teardown): this consumer's TSFNs are being
// freed — make sure the producer never posts to them again.
void DetachConsumerForTeardown(CaptureSink *sink) {
  MicHub &hub = Hub();
  for (const std::shared_ptr<MicConsumer> &consumer : hub.consumers) {
    if (consumer->sink.get() == sink) {
      std::shared_ptr<MicConsumer> keep = consumer;
      DetachConsumer(hub, keep, false);
      return;
    }
  }
}

napi_value FailMicStart(napi_env env, const char *message) {
  SetLastError(MicDiagnostics(), message);
  Throw(env, message);
  return nullptr;
}

}  // namespace

// startMicrophoneCapture(onPcm | null, deviceUid?, onError?, sampleRate?)
//   -> consumer id (number)
//
// Attaches one consumer to the shared capture, starting the queue for the
// first one. A null onPcm captures without delivering PCM to JS: mic
// passthrough only needs the native tee, and posting 25 chunks/s through a
// TSFN into a no-op callback all day long was pure overhead.
napi_value StartMicrophoneCapture(napi_env env, napi_callback_info info) {
  MicHub &hub = Hub();
  size_t argc = 4;
  napi_value args[4];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  napi_value onPcm = OptionalFunctionArg(env, args, argc, 0);
  if (!onPcm && argc >= 1) {
    napi_valuetype type;
    napi_typeof(env, args[0], &type);
    if (type != napi_null && type != napi_undefined) {
      Throw(env, "startMicrophoneCapture callback must be a function or null");
      return nullptr;
    }
  }

  std::string deviceUid;
  if (argc >= 2) {
    napi_valuetype uidType;
    napi_typeof(env, args[1], &uidType);
    if (uidType == napi_string) {
      deviceUid = StringArg(env, args[1]);
    }
  }
  napi_value onError = OptionalFunctionArg(env, args, argc, 2);
  Float64 sampleRate = kDefaultCaptureSampleRate;
  if (!CaptureSampleRateArg(env, args, argc, 3, sampleRate)) return nullptr;

  // Without consent the queue still "runs" and records zeros, so a session
  // looked healthy while sending silence. notDetermined is let through:
  // starting the queue is what raises the consent prompt.
  const AVAuthorizationStatus micAuth = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
  if (micAuth == AVAuthorizationStatusDenied || micAuth == AVAuthorizationStatusRestricted) {
    return FailMicStart(env, micAuth == AVAuthorizationStatusDenied
      ? "麦克风权限已被拒绝：请在「系统设置 → 隐私与安全性 → 麦克风」中允许 BabelVoice 访问麦克风，然后重试。"
      : "麦克风访问受系统限制（家长控制或设备管理策略），BabelVoice 无法采集麦克风。");
  }
  const std::string refusal = VirtualInputRefusal(deviceUid);
  if (!refusal.empty()) return FailMicStart(env, refusal.c_str());

  const bool deliverPcm = onPcm != nullptr;
  if (deliverPcm) {
    const bool slotFree = std::any_of(hub.pcmSlots.begin(), hub.pcmSlots.end(), [](const std::atomic<MicConsumer *> &slot) {
      return slot.load(std::memory_order_relaxed) == nullptr;
    });
    if (!slotFree) return FailMicStart(env, "too many microphone PCM consumers");
  }

  auto consumer = std::make_shared<MicConsumer>();
  consumer->id = hub.nextConsumerId++;
  consumer->deliverPcm = deliverPcm;
  consumer->sampleRate = sampleRate;
  if (deliverPcm && sampleRate != kMicHubSampleRate) {
    consumer->resampler = PcmResampler::Create(kMicHubSampleRate, sampleRate, kMicBufferFrames);
    if (!consumer->resampler) return FailMicStart(env, "failed to create the microphone resampler");
  }
  consumer->sink = CreateCaptureSink(env, onPcm, onError, "BabelVoiceMicrophoneCapture", DetachConsumerForTeardown);
  if (!consumer->sink) {
    Throw(env, "failed to create microphone callback");
    return nullptr;
  }

  // Join the running queue when it already records the requested device;
  // otherwise (first consumer, another device, or a failed run) build one.
  std::string error;
  bool ok = true;
  if (!hub.run) {
    hub.run = StartRun(hub, deviceUid, error);
    ok = hub.run != nullptr;
  } else if (hub.run->deviceUid != deviceUid || !hub.run->shared->Healthy()) {
    ok = RestartRun(hub, deviceUid, error);
  }
  if (!ok) {
    consumer->sink->Release();
    // Consumers that were already attached (now failed) keep the hub slot
    // until their owners stop them.
    return FailMicStart(env, error.c_str());
  }

  hub.consumers.push_back(consumer);
  hub.run->shared->Add(consumer);
  if (deliverPcm) {
    for (std::atomic<MicConsumer *> &slot : hub.pcmSlots) {
      MicConsumer *expected = nullptr;
      if (slot.compare_exchange_strong(expected, consumer.get(), std::memory_order_seq_cst)) break;
    }
  }
  return MakeNumber(env, consumer->id);
}

// stopMicrophoneCapture(consumerId?) -> true
//
// Detaches that consumer (the last one out stops the queue). Without an id:
// every consumer and the queue — the bulk "stop all native audio" path.
// Unknown ids are a no-op, and ids are never reused, so a stale id can't
// stop somebody else's consumer.
napi_value StopMicrophoneCapture(napi_env env, napi_callback_info info) {
  MicHub &hub = Hub();
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  napi_valuetype type = napi_undefined;
  if (argc >= 1) napi_typeof(env, args[0], &type);
  if (type == napi_undefined) {
    StopAll(hub, true);
    return MakeBool(env, true);
  }
  double id = 0;
  if (type != napi_number || napi_get_value_double(env, args[0], &id) != napi_ok) {
    Throw(env, "stopMicrophoneCapture consumerId must be a number");
    return nullptr;
  }
  if (id >= 1 && id <= UINT32_MAX && std::floor(id) == id) {
    if (std::shared_ptr<MicConsumer> consumer = FindConsumer(hub, static_cast<uint32_t>(id))) {
      DetachConsumer(hub, consumer, true);
    }
  }
  return MakeBool(env, true);
}

// Toggle the mic passthrough tee. The caller is responsible for ensuring a
// mic consumer is attached (startMicrophoneCapture) and the TTS AudioUnit is
// prepared at the mic rate (prepareTtsOutput(24000)). When disabling, we
// flush any residual mic samples already buffered so a subsequent
// translation session doesn't replay stale microphone audio.
napi_value SetMicPassthroughEnabled(napi_env env, napi_callback_info info) {
  MicHub &hub = Hub();
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  bool enabled = false;
  if (argc >= 1) napi_get_value_bool(env, args[0], &enabled);
  if (enabled && hub.run && TtsUnitSampleRate() != kMicHubSampleRate) {
    // Teeing 24 kHz mic samples into a 16 kHz unit would play the speaker's
    // voice to the meeting at the wrong pitch.
    Throw(env, "mic passthrough needs the microphone and TTS output at the same sample rate");
    return nullptr;
  }
  if (enabled) {
    // Start from a filled jitter buffer rather than an empty ring.
    ArmTtsPrebuffer();
    const auto enable = [] { SetMicPassthroughFlag(true); };
    // Under the run's lock: a run that already failed (Fail turned the tee
    // off) must not get it back.
    bool ok = true;
    if (hub.run) {
      ok = hub.run->shared->IfHealthy(enable);
    } else {
      enable();
    }
    if (!ok) {
      Throw(env, "microphone capture has failed; restart it before enabling mic passthrough");
      return nullptr;
    }
    return MakeBool(env, true);
  }
  if (ClearMicPassthroughFlag()) {
    FlushTtsOutputUnit();
  }
  return MakeBool(env, true);
}

// getMicrophoneCaptureState() -> { running, sampleRate, deviceUid, failed,
//   consumers, pcmConsumers, queueStarts, passthrough }
napi_value GetMicrophoneCaptureState(napi_env env, napi_callback_info info) {
  (void)info;
  MicHub &hub = Hub();
  size_t pcmConsumers = 0;
  for (const std::shared_ptr<MicConsumer> &consumer : hub.consumers) {
    if (consumer->deliverPcm) pcmConsumers++;
  }
  napi_value obj;
  napi_create_object(env, &obj);
  SetNamed(env, obj, "running", MakeBool(env, hub.run != nullptr));
  SetNamed(env, obj, "sampleRate", MakeNumber(env, hub.run ? kMicHubSampleRate : 0));
  SetNamed(env, obj, "deviceUid", MakeString(env, hub.run ? hub.run->deviceUid.c_str() : ""));
  SetNamed(env, obj, "failed", MakeBool(env, hub.run && !hub.run->shared->Healthy()));
  SetNamed(env, obj, "consumers", MakeNumber(env, static_cast<double>(hub.consumers.size())));
  SetNamed(env, obj, "pcmConsumers", MakeNumber(env, static_cast<double>(pcmConsumers)));
  SetNamed(env, obj, "queueStarts", MakeNumber(env, static_cast<double>(hub.queueStarts)));
  SetNamed(env, obj, "passthrough", MakeBool(env, MicPassthroughEnabled()));
  return obj;
}

void StopMicrophoneForTeardown() {
  StopAll(Hub(), false);
}

}  // namespace babelvoice
