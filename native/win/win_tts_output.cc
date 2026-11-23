// TTS output to the virtual loopback (VB-Cable's "CABLE Input"): one
// event-driven WASAPI render stream on a worker thread, fed from a FIFO,
// plus the mic-passthrough tee's entry point into it. Implements
// tts_output.h for Windows.
//
// Like the macOS HAL AudioUnit, the stream runs continuously and renders
// silence whenever the FIFO is empty, so the virtual device never idles and
// translated audio starts the instant it arrives.
#include "../tts_output.h"

#include <audioclient.h>

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <deque>
#include <future>
#include <mutex>
#include <string>
#include <thread>

#include "../diagnostics.h"
#include "../napi_util.h"
#include "win_common.h"
#include "win_devices.h"
#include "win_pcm.h"

namespace babelvoice {

namespace {

// Backlog cap in time: a 24 kHz engine gets the same headroom as 16 kHz.
constexpr double kTtsMaxQueuedSeconds = 120;
// 40 ms device buffer: small enough for low passthrough latency, large
// enough that a worker thread can't underrun it between wake-ups.
constexpr REFERENCE_TIME kRenderBufferDuration = 400000;

class TtsOutput {
 public:
  TtsOutput() : diag_(TtsDiagnostics()) {}

  std::atomic_bool micPassthroughEnabled{false};

  void ArmPrebuffer() { prebuffering_.store(true, std::memory_order_release); }
  double unitSampleRate() const { return running_ ? sampleRate_ : 0; }  // JS thread

  bool Prepare(double sampleRate, const std::string &devicePattern, std::string &error);
  bool Enqueue(const int16_t *src, size_t sampleCount, double sampleRate, std::string &error);
  void Tee(const int16_t *src, size_t sampleCount, double sampleRate);
  void Flush();
  void Dispose();
  double PendingMs();
  void ReportPlayed(const void *bytes, size_t length) {
    UpdateDiagnostics(diag_, bytes, length, routeStatus_.c_str());
  }

 private:
  void RenderLoop(std::string deviceId, double sampleRate, std::promise<std::string> ready);
  void ConfigurePassthroughThresholds(double sampleRate);
  // Under queueMutex_: drop up to `count` of the oldest samples.
  void DropFrontLocked(size_t count);

  NativeDiagnostics &diag_;

  // JS thread only.
  bool running_ = false;
  double sampleRate_ = 0;
  std::string devicePattern_;
  std::string deviceId_;
  uint64_t deviceGeneration_ = 0;
  std::string routeStatus_ = "idle";
  std::thread thread_;
  HANDLE stopEvent_ = nullptr;

  // Shared with the render thread.
  std::atomic_bool dead_{false};  // the stream failed (device gone)
  std::atomic<double> liveSampleRate_{0};
  std::atomic_bool prebuffering_{true};
  std::atomic<size_t> prebufferSamples_{0};
  std::atomic<size_t> passthroughMaxSamples_{0};
  std::atomic<size_t> passthroughTargetSamples_{0};
  std::mutex queueMutex_;
  std::deque<int16_t> queue_;  // guarded by queueMutex_
};

TtsOutput &Tts() {
  static TtsOutput *const tts = new TtsOutput();
  return *tts;
}

void TtsOutput::ConfigurePassthroughThresholds(double sampleRate) {
  // ~60ms jitter buffer; passthrough latency capped at ~300ms and trimmed
  // back to ~120ms when exceeded (same as macOS).
  prebufferSamples_.store(static_cast<size_t>(sampleRate * 0.060));
  passthroughMaxSamples_.store(static_cast<size_t>(sampleRate * 0.300));
  passthroughTargetSamples_.store(static_cast<size_t>(sampleRate * 0.120));
}

void TtsOutput::DropFrontLocked(size_t count) {
  count = std::min(count, queue_.size());
  queue_.erase(queue_.begin(), queue_.begin() + static_cast<std::ptrdiff_t>(count));
  diag_.droppedSamples.fetch_add(count, std::memory_order_relaxed);
}

void TtsOutput::RenderLoop(std::string deviceId, double sampleRate, std::promise<std::string> ready) {
  ScopedCom com;
  HANDLE renderEvent = nullptr;
  ComPtr<IAudioClient> client;
  ComPtr<IAudioRenderClient> render;
  UINT32 bufferFrames = 0;
  const auto fail = [&](const std::string &message) {
    if (renderEvent) CloseHandle(renderEvent);
    ready.set_value(message);
  };

  ComPtr<IMMDevice> device = EndpointForId(deviceId);
  if (!device) return fail("virtual loopback output device not found");
  HRESULT hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &client);
  if (FAILED(hr)) return fail(HrMessage("IMMDevice::Activate(IAudioClient) failed", hr));
  const WAVEFORMATEX format = MonoInt16Format(sampleRate);
  hr = client->Initialize(
    AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
    kRenderBufferDuration, 0, &format, nullptr);
  if (FAILED(hr)) return fail(HrMessage("IAudioClient::Initialize(render) failed", hr));
  renderEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (!renderEvent) return fail("CreateEvent failed");
  if (FAILED(hr = client->SetEventHandle(renderEvent))) return fail(HrMessage("SetEventHandle failed", hr));
  if (FAILED(hr = client->GetBufferSize(&bufferFrames))) return fail(HrMessage("GetBufferSize failed", hr));
  if (FAILED(hr = client->GetService(IID_PPV_ARGS(&render)))) {
    return fail(HrMessage("GetService(IAudioRenderClient) failed", hr));
  }
  // Pre-roll one buffer of silence so Start doesn't begin with a glitch.
  BYTE *data = nullptr;
  if (SUCCEEDED(render->GetBuffer(bufferFrames, &data))) {
    render->ReleaseBuffer(bufferFrames, AUDCLNT_BUFFERFLAGS_SILENT);
  }
  if (FAILED(hr = client->Start())) return fail(HrMessage("IAudioClient::Start(render) failed", hr));
  liveSampleRate_.store(sampleRate, std::memory_order_release);
  ready.set_value({});

  const HANDLE waits[2] = {stopEvent_, renderEvent};
  for (;;) {
    const DWORD signalled = WaitForMultipleObjects(2, waits, FALSE, 200);
    if (signalled == WAIT_OBJECT_0) break;
    UINT32 padding = 0;
    hr = client->GetCurrentPadding(&padding);
    if (FAILED(hr)) break;
    const UINT32 available = bufferFrames - padding;
    if (available == 0) continue;
    hr = render->GetBuffer(available, &data);
    if (FAILED(hr)) break;
    auto *out = reinterpret_cast<int16_t *>(data);
    size_t written = 0;
    {
      std::lock_guard<std::mutex> lock(queueMutex_);
      const bool passthrough = micPassthroughEnabled.load(std::memory_order_acquire);
      bool play = true;
      if (passthrough && prebuffering_.load(std::memory_order_acquire)) {
        // Jitter buffer: wait for ~60ms before playing mic audio.
        if (queue_.size() < prebufferSamples_.load()) {
          play = false;
        } else {
          prebuffering_.store(false, std::memory_order_release);
        }
      }
      if (play) {
        written = std::min<size_t>(available, queue_.size());
        std::copy(queue_.begin(), queue_.begin() + static_cast<std::ptrdiff_t>(written), out);
        queue_.erase(queue_.begin(), queue_.begin() + static_cast<std::ptrdiff_t>(written));
        if (written < available && passthrough) prebuffering_.store(true, std::memory_order_release);
      }
      diag_.queuedSamples.store(queue_.size(), std::memory_order_relaxed);
    }
    if (written < available) {
      std::fill(out + written, out + available, int16_t{0});
      if (written > 0) diag_.underruns.fetch_add(1, std::memory_order_relaxed);
    }
    render->ReleaseBuffer(available, 0);
  }
  if (FAILED(hr)) {
    // Device unplugged / VB-Cable removed / endpoint reconfigured: the next
    // Prepare (every playPcm runs one) rebuilds the stream.
    dead_.store(true, std::memory_order_release);
    SetLastError(diag_, HrMessage("TTS output stream failed", hr).c_str());
    SetRouteStatus(diag_, "failed");
  }
  liveSampleRate_.store(0, std::memory_order_release);
  client->Stop();
  CloseHandle(renderEvent);
}

bool TtsOutput::Prepare(double sampleRate, const std::string &devicePattern, std::string &error) {
  ScopedCom com(COINIT_APARTMENTTHREADED);  // JS thread: Electron's main thread is STA already
  EnsureDeviceNotifications();
  if (running_ && !dead_.load(std::memory_order_acquire) && sampleRate_ == sampleRate &&
      devicePattern_ == devicePattern) {
    // Hot path (every playPcm): skip the device walk unless the topology
    // changed since the stream was last validated.
    const uint64_t generation = DeviceTopologyGeneration();
    if (generation == deviceGeneration_) return true;
    if (FindVirtualOutputId(devicePattern) == deviceId_) {
      deviceGeneration_ = generation;
      return true;
    }
  }
  if (running_) Dispose();

  const uint64_t generation = DeviceTopologyGeneration();
  const std::string deviceId = FindVirtualOutputId(devicePattern);
  if (deviceId.empty()) {
    error = "virtual loopback output device not found";
    SetLastError(diag_, error.c_str());
    return false;
  }
  if (!stopEvent_) stopEvent_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  ResetEvent(stopEvent_);
  dead_.store(false, std::memory_order_release);
  ConfigurePassthroughThresholds(sampleRate);
  prebuffering_.store(true, std::memory_order_release);

  std::promise<std::string> ready;
  std::future<std::string> started = ready.get_future();
  thread_ = std::thread(&TtsOutput::RenderLoop, this, deviceId, sampleRate, std::move(ready));
  error = started.get();
  if (!error.empty()) {
    thread_.join();
    SetLastError(diag_, error.c_str());
    return false;
  }
  running_ = true;
  sampleRate_ = sampleRate;
  devicePattern_ = devicePattern;
  deviceId_ = deviceId;
  deviceGeneration_ = generation;

  const std::string name = EndpointName(EndpointForId(deviceId).Get());
  routeStatus_ = "virtual-output:" + (name.empty() ? std::string("unknown") : name) + ":" + deviceId;
  SetRouteStatus(diag_, routeStatus_.c_str());
  return true;
}

bool TtsOutput::Enqueue(const int16_t *src, size_t sampleCount, double sampleRate, std::string &error) {
  const size_t maxQueuedSamples = static_cast<size_t>(kTtsMaxQueuedSeconds * sampleRate);
  std::lock_guard<std::mutex> lock(queueMutex_);
  if (queue_.size() + sampleCount > maxQueuedSamples) {
    diag_.droppedSamples.fetch_add(sampleCount, std::memory_order_acq_rel);
    SetLastError(diag_, "TTS output backlog overflow");
    error = "TTS output backlog overflow";
    return false;
  }
  queue_.insert(queue_.end(), src, src + sampleCount);
  diag_.queuedSamples.store(queue_.size(), std::memory_order_release);
  return true;
}

void TtsOutput::Tee(const int16_t *src, size_t sampleCount, double sampleRate) {
  if (!src || sampleCount == 0) return;
  // No stream: nothing would ever drain the queue. A stream at another rate
  // (a 16 kHz engine's TTS) would play the voice pitch-shifted.
  if (liveSampleRate_.load(std::memory_order_acquire) != sampleRate) return;
  std::lock_guard<std::mutex> lock(queueMutex_);
  queue_.insert(queue_.end(), src, src + sampleCount);
  const size_t maxSamples = passthroughMaxSamples_.load();
  if (maxSamples > 0 && queue_.size() > maxSamples) {
    // A stalled device must not leave the call permanently delayed: drop
    // the oldest audio back down to the target latency.
    DropFrontLocked(queue_.size() - passthroughTargetSamples_.load());
  }
  diag_.queuedSamples.store(queue_.size(), std::memory_order_release);
}

void TtsOutput::Flush() {
  std::lock_guard<std::mutex> lock(queueMutex_);
  queue_.clear();
  diag_.queuedSamples.store(0, std::memory_order_release);
  prebuffering_.store(true, std::memory_order_release);
}

void TtsOutput::Dispose() {
  if (thread_.joinable()) {
    SetEvent(stopEvent_);
    thread_.join();
  }
  running_ = false;
  sampleRate_ = 0;
  deviceId_.clear();
  devicePattern_.clear();
  Flush();
  routeStatus_ = "idle";
  SetRouteStatus(diag_, "idle");
}

double TtsOutput::PendingMs() {
  if (!running_ || sampleRate_ <= 0) return 0;
  size_t pending = 0;
  {
    std::lock_guard<std::mutex> lock(queueMutex_);
    pending = queue_.size();
  }
  return static_cast<double>(pending) * 1000.0 / sampleRate_;
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
  double sampleRate = kDefaultCaptureSampleRate;
  if (!TtsSampleRateArg(env, args, argc, 0, sampleRate)) return nullptr;
  std::string pattern = kDefaultVirtualPattern;
  if (argc >= 2) pattern = StringArg(env, args[1]);

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
  double sampleRate = kDefaultCaptureSampleRate;
  if (!TtsSampleRateArg(env, args, argc, 1, sampleRate)) return nullptr;
  std::string pattern = kDefaultVirtualPattern;
  if (argc >= 3) pattern = StringArg(env, args[2]);

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

napi_value GetTtsPendingMs(napi_env env, napi_callback_info info) {
  (void)info;
  return MakeNumber(env, Tts().PendingMs());
}

}  // namespace babelvoice
