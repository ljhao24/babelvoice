// Microphone capture: one shared WASAPI capture stream fanned out to every
// consumer (JS PCM sinks at their own rate, the passthrough tee), plus the
// mic passthrough toggle. Implements mic_capture.h for Windows.
//
// Same model as macOS: a single "run" records at kMicHubSampleRate on a
// worker thread; consumers attach and detach without touching it; it starts
// with the first consumer, stops with the last one, and is rebuilt only for
// another device or after it failed. An unpinned run follows the system
// default input (reopening on the new default) and fails if that becomes
// the virtual cable.
//
// Threads: the JS thread owns the hub. The capture thread reaches consumers
// only under MicRun::mutex, so once Remove() returns it never touches that
// consumer again — no lock-free slots needed (WASAPI capture threads aren't
// real-time IO threads the way HAL IOProcs are).
#include "../mic_capture.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <future>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "../capture_sink.h"
#include "../diagnostics.h"
#include "../napi_util.h"
#include "../tts_output.h"
#include "win_capture_stream.h"
#include "win_common.h"
#include "win_devices.h"
#include "win_pcm.h"

namespace babelvoice {

namespace {

// 24 kHz: the passthrough tee needs it and it is the highest capture rate a
// TranslationClient takes; 16 kHz consumers are resampled from it.
constexpr double kMicHubSampleRate = 24000;

struct MicConsumer {
  uint32_t id = 0;
  std::shared_ptr<CaptureSink> sink;
  bool deliverPcm = false;
  double sampleRate = kMicHubSampleRate;
  std::unique_ptr<StreamResampler> resampler;  // capture thread, under MicRun::mutex
  std::atomic_bool failed{false};
};

struct MicRun {
  std::string deviceUid;  // as requested; empty = follow the system default
  std::thread thread;
  HANDLE stopEvent = nullptr;

  std::mutex mutex;
  bool stopped = false;                                 // guarded by mutex
  bool failed = false;                                  // guarded by mutex
  std::string failure;                                  // guarded by mutex
  std::vector<std::shared_ptr<MicConsumer>> consumers;  // guarded by mutex

  ~MicRun() {
    if (stopEvent) CloseHandle(stopEvent);
  }

  // Any thread. The first failure turns the passthrough tee off right here —
  // a dead or looping mic must not keep feeding the virtual device — and
  // tells every consumer once.
  void Fail(const char *message) {
    std::lock_guard<std::mutex> lock(mutex);
    if (stopped || failed) return;
    failed = true;
    failure = message ? message : "";
    SetMicPassthroughFlag(false);
    SetLastError(MicDiagnostics(), failure.c_str());
    SetRouteStatus(MicDiagnostics(), "failed");
    for (const std::shared_ptr<MicConsumer> &consumer : consumers) FailConsumerLocked(*consumer);
  }

  void Add(const std::shared_ptr<MicConsumer> &consumer) {
    std::lock_guard<std::mutex> lock(mutex);
    consumers.push_back(consumer);
    if (failed) FailConsumerLocked(*consumer);
  }

  void Remove(const MicConsumer *consumer) {
    std::lock_guard<std::mutex> lock(mutex);
    consumers.erase(
      std::remove_if(consumers.begin(), consumers.end(),
                     [consumer](const std::shared_ptr<MicConsumer> &c) { return c.get() == consumer; }),
      consumers.end());
  }

  // No failure is reported once this returns; hands back the healthy consumers.
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

  template <typename Fn>
  bool IfHealthy(Fn &&fn) {
    std::lock_guard<std::mutex> lock(mutex);
    if (stopped || failed) return false;
    fn();
    return true;
  }

  // Capture thread: fan one chunk of hub-rate PCM out to the consumers.
  void Dispatch(const std::vector<int16_t> &samples) {
    std::lock_guard<std::mutex> lock(mutex);
    if (stopped || failed) return;
    std::vector<int16_t> converted;
    for (const std::shared_ptr<MicConsumer> &consumer : consumers) {
      if (!consumer->deliverPcm || consumer->failed.load(std::memory_order_acquire)) continue;
      if (consumer->resampler) {
        converted.clear();
        consumer->resampler->ProcessInt16(samples.data(), samples.size(), converted);
        if (!converted.empty()) {
          consumer->sink->PostPcm(CopyPacket(converted.data(), converted.size() * sizeof(int16_t)));
        }
      } else {
        consumer->sink->PostPcm(CopyPacket(samples.data(), samples.size() * sizeof(int16_t)));
      }
    }
    // Mic passthrough: while no translation session runs, the meeting peer
    // still hears the speaker through the virtual cable.
    if (MicPassthroughEnabled()) TeeMicToTtsQueue(samples.data(), samples.size(), kMicHubSampleRate);
  }

 private:
  void FailConsumerLocked(MicConsumer &consumer) {
    if (consumer.failed.exchange(true, std::memory_order_acq_rel)) return;
    consumer.sink->Fail(failure.c_str(), [] {});
  }
};

struct MicHub {
  std::unique_ptr<MicRun> run;
  std::vector<std::shared_ptr<MicConsumer>> consumers;
  uint32_t nextConsumerId = 1;
  uint64_t queueStarts = 0;
};

MicHub &Hub() {
  static MicHub *const hub = new MicHub();
  return *hub;
}

// Empty when `device` may be recorded. Recording the virtual cable itself
// would feed our own output straight back in: passthrough would loop and
// speak mode would translate its own TTS.
std::string VirtualInputRefusal(IMMDevice *device, bool isDefault) {
  const std::string name = EndpointName(device);
  if (!NameMatchesPattern(name, kDefaultVirtualPattern)) return {};
  return std::string(isDefault ? "系统默认输入设备是虚拟声卡「" : "所选的输入设备是虚拟声卡「") + name +
         "」，直接采集会把翻译输出回录成麦克风输入。请在 BabelVoice 设置中选择真实的麦克风。";
}

// Capture thread, COM initialized. Opens the pinned device or the current
// default; nullptr + `error` on failure.
std::unique_ptr<CaptureStream> OpenMicStream(const std::string &deviceUid, std::string &error) {
  ComPtr<IMMDevice> device = deviceUid.empty() ? DefaultEndpoint(eCapture) : EndpointForId(deviceUid);
  if (!device) {
    error = deviceUid.empty() ? "没有可用的麦克风（系统未设置默认输入设备）" : "所选的麦克风不存在或已断开";
    return nullptr;
  }
  error = VirtualInputRefusal(device.Get(), deviceUid.empty());
  if (!error.empty()) return nullptr;
  std::unique_ptr<CaptureStream> stream = CaptureStream::OpenEndpoint(device.Get(), false, kMicHubSampleRate, error);
  if (stream && !stream->Start(error)) stream.reset();
  return stream;
}

void CaptureLoop(MicRun *run, std::promise<std::string> ready) {
  ScopedCom com;
  std::string error;
  uint64_t defaultGeneration = DefaultCaptureGeneration();
  std::unique_ptr<CaptureStream> stream = OpenMicStream(run->deviceUid, error);
  ready.set_value(stream ? std::string() : error);
  if (!stream) return;
  SetRouteStatus(MicDiagnostics(), "capturing");

  std::vector<int16_t> samples;
  for (;;) {
    const HANDLE waits[2] = {run->stopEvent, stream->event()};
    if (WaitForMultipleObjects(2, waits, FALSE, 100) == WAIT_OBJECT_0) return;

    if (run->deviceUid.empty() && DefaultCaptureGeneration() != defaultGeneration) {
      // An unpinned capture follows the system default input.
      defaultGeneration = DefaultCaptureGeneration();
      stream.reset();
      stream = OpenMicStream({}, error);
      if (!stream) {
        run->Fail(error.find("虚拟声卡") != std::string::npos
          ? "系统默认输入设备被切换成了虚拟声卡，继续采集会形成回环，请改用真实的麦克风"
          : ("切换到新的默认麦克风失败：" + error).c_str());
        return;
      }
      continue;
    }

    samples.clear();
    const HRESULT hr = stream->Read(samples);
    if (!samples.empty()) {
      UpdateDiagnostics(MicDiagnostics(), samples.data(), samples.size() * sizeof(int16_t), "capturing");
      run->Dispatch(samples);
    }
    if (FAILED(hr)) {
      if (hr == AUDCLNT_E_DEVICE_INVALIDATED && run->deviceUid.empty()) {
        // The default device went away; the default-change notification
        // usually lands right after. Try whatever the default is now.
        stream.reset();
        stream = OpenMicStream({}, error);
        defaultGeneration = DefaultCaptureGeneration();
        if (stream) continue;
      }
      run->Fail(hr == AUDCLNT_E_DEVICE_INVALIDATED ? "麦克风设备已断开"
                                                   : "麦克风采集意外停止（输入设备可能已断开）");
      return;
    }
  }
}

// JS thread. Synchronously stops `run`; afterwards its thread is gone and no
// failure is reported for it.
void DestroyRun(std::unique_ptr<MicRun> run) {
  if (!run) return;
  run->Stop();
  if (run->thread.joinable()) {
    SetEvent(run->stopEvent);
    run->thread.join();
  }
}

std::unique_ptr<MicRun> StartRun(MicHub &hub, const std::string &deviceUid, std::string &error) {
  EnsureDeviceNotifications();
  auto run = std::make_unique<MicRun>();
  run->deviceUid = deviceUid;
  run->stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!run->stopEvent) {
    error = "CreateEvent failed";
    return nullptr;
  }
  std::promise<std::string> ready;
  std::future<std::string> started = ready.get_future();
  run->thread = std::thread(CaptureLoop, run.get(), std::move(ready));
  hub.queueStarts++;
  error = started.get();
  if (!error.empty()) {
    DestroyRun(std::move(run));
    return nullptr;
  }
  return run;
}

bool RestartRun(MicHub &hub, const std::string &deviceUid, std::string &error) {
  std::unique_ptr<MicRun> old = std::move(hub.run);
  std::vector<std::shared_ptr<MicConsumer>> carried = old->Stop();
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
  for (const std::shared_ptr<MicConsumer> &consumer : carried) hub.run->Add(consumer);
  return true;
}

void StopRun(MicHub &hub) {
  SetMicPassthroughFlag(false);
  if (!hub.run) return;
  DestroyRun(std::move(hub.run));
  SetRouteStatus(MicDiagnostics(), "idle");
}

void DetachConsumer(MicHub &hub, const std::shared_ptr<MicConsumer> &consumer, bool releaseJs) {
  hub.consumers.erase(std::remove(hub.consumers.begin(), hub.consumers.end(), consumer), hub.consumers.end());
  consumer->sink->BeginStop();
  if (hub.run) hub.run->Remove(consumer.get());
  if (hub.consumers.empty()) StopRun(hub);
  if (releaseJs) {
    consumer->sink->Release();
  } else {
    consumer->sink->Detach();
  }
}

void StopAll(MicHub &hub, bool releaseJs) {
  SetMicPassthroughFlag(false);
  std::vector<std::shared_ptr<MicConsumer>> consumers = std::move(hub.consumers);
  hub.consumers.clear();
  for (const std::shared_ptr<MicConsumer> &consumer : consumers) consumer->sink->BeginStop();
  StopRun(hub);
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

napi_value StartMicrophoneCapture(napi_env env, napi_callback_info info) {
  ScopedCom com(COINIT_APARTMENTTHREADED);
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
    if (uidType == napi_string) deviceUid = StringArg(env, args[1]);
  }
  napi_value onError = OptionalFunctionArg(env, args, argc, 2);
  double sampleRate = kDefaultCaptureSampleRate;
  if (!CaptureSampleRateArg(env, args, argc, 3, sampleRate)) return nullptr;

  if (std::string(MicrophonePermissionStatus()) == "denied") {
    return FailMicStart(env,
      "麦克风权限已关闭：请在「设置 → 隐私和安全性 → 麦克风」中打开「麦克风访问权限」和「允许桌面应用访问麦克风」，然后重试。");
  }

  const bool deliverPcm = onPcm != nullptr;
  auto consumer = std::make_shared<MicConsumer>();
  consumer->id = hub.nextConsumerId++;
  consumer->deliverPcm = deliverPcm;
  consumer->sampleRate = sampleRate;
  if (deliverPcm && sampleRate != kMicHubSampleRate) {
    consumer->resampler = std::make_unique<StreamResampler>(kMicHubSampleRate, sampleRate);
  }
  consumer->sink = CreateCaptureSink(env, onPcm, onError, "BabelVoiceMicrophoneCapture", DetachConsumerForTeardown);
  if (!consumer->sink) {
    Throw(env, "failed to create microphone callback");
    return nullptr;
  }

  // Join the running capture when it already records the requested device;
  // otherwise (first consumer, another device, or a failed run) build one.
  std::string error;
  bool ok = true;
  if (!hub.run) {
    hub.run = StartRun(hub, deviceUid, error);
    ok = hub.run != nullptr;
  } else if (hub.run->deviceUid != deviceUid || !hub.run->Healthy()) {
    ok = RestartRun(hub, deviceUid, error);
  }
  if (!ok) {
    consumer->sink->Release();
    return FailMicStart(env, error.c_str());
  }
  hub.consumers.push_back(consumer);
  hub.run->Add(consumer);
  return MakeNumber(env, consumer->id);
}

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

napi_value SetMicPassthroughEnabled(napi_env env, napi_callback_info info) {
  MicHub &hub = Hub();
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  bool enabled = false;
  if (argc >= 1) napi_get_value_bool(env, args[0], &enabled);
  if (enabled && hub.run && TtsUnitSampleRate() != kMicHubSampleRate) {
    Throw(env, "mic passthrough needs the microphone and TTS output at the same sample rate");
    return nullptr;
  }
  if (enabled) {
    ArmTtsPrebuffer();
    const auto enable = [] { SetMicPassthroughFlag(true); };
    bool ok = true;
    if (hub.run) {
      ok = hub.run->IfHealthy(enable);
    } else {
      enable();
    }
    if (!ok) {
      Throw(env, "microphone capture has failed; restart it before enabling mic passthrough");
      return nullptr;
    }
    return MakeBool(env, true);
  }
  if (ClearMicPassthroughFlag()) FlushTtsOutputUnit();
  return MakeBool(env, true);
}

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
  SetNamed(env, obj, "failed", MakeBool(env, hub.run && !hub.run->Healthy()));
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
