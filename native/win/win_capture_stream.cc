#include "win_capture_stream.h"

#include <audioclientactivationparams.h>
#include <wrl/implements.h>

#include <cstring>

namespace babelvoice {

namespace {

// 100 ms of WASAPI buffer: plenty of slack for a worker thread that wakes
// every 10-20 ms, and no added latency (we drain whatever is ready).
constexpr REFERENCE_TIME kBufferDuration = 1000000;

// Completion handler for ActivateAudioInterfaceAsync. Agile (FtmBase): the
// callback arrives on a system MTA thread.
class ActivationHandler
    : public Microsoft::WRL::RuntimeClass<
        Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
        Microsoft::WRL::FtmBase,
        IActivateAudioInterfaceCompletionHandler> {
 public:
  ActivationHandler() { done_ = CreateEventW(nullptr, TRUE, FALSE, nullptr); }
  ~ActivationHandler() override {
    if (done_) CloseHandle(done_);
  }
  STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation *operation) override {
    HRESULT activateResult = E_FAIL;
    ComPtr<IUnknown> unknown;
    result_ = operation->GetActivateResult(&activateResult, &unknown);
    if (SUCCEEDED(result_)) result_ = activateResult;
    if (SUCCEEDED(result_)) result_ = unknown.As(&client_);
    SetEvent(done_);
    return S_OK;
  }
  HANDLE done() const { return done_; }
  HRESULT result() const { return result_; }
  ComPtr<IAudioClient> client() const { return client_; }

 private:
  HANDLE done_ = nullptr;
  HRESULT result_ = E_FAIL;
  ComPtr<IAudioClient> client_;
};

}  // namespace

CaptureStream::~CaptureStream() {
  if (client_ && started_) client_->Stop();
  capture_.Reset();
  client_.Reset();
  if (event_) CloseHandle(event_);
}

bool CaptureStream::Initialize(IAudioClient *client, DWORD extraFlags, const WAVEFORMATEX *fallback, std::string &error) {
  // First choice: let the audio engine down-mix and resample to exactly what
  // the consumer wants.
  const WAVEFORMATEX direct = MonoInt16Format(outputRate_);
  const DWORD flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK | extraFlags;
  HRESULT hr = client->Initialize(
    AUDCLNT_SHAREMODE_SHARED,
    flags | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
    kBufferDuration, 0, &direct, nullptr);
  if (FAILED(hr)) {
    // Fall back to the engine's own format and convert ourselves.
    WAVEFORMATEX *mix = nullptr;
    const WAVEFORMATEX *format = fallback;
    if (!format) {
      hr = client->GetMixFormat(&mix);
      if (FAILED(hr) || !mix) {
        error = HrMessage("IAudioClient::GetMixFormat failed", hr);
        return false;
      }
      format = mix;
    }
    converter_ = CaptureConverter::Create(format, outputRate_);
    if (!converter_) {
      if (mix) CoTaskMemFree(mix);
      error = "unsupported audio capture format";
      return false;
    }
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, kBufferDuration, 0, format, nullptr);
    if (mix) CoTaskMemFree(mix);
    if (FAILED(hr)) {
      error = HrMessage("IAudioClient::Initialize failed", hr);
      return false;
    }
  }
  event_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (!event_) {
    error = "CreateEvent failed";
    return false;
  }
  hr = client->SetEventHandle(event_);
  if (FAILED(hr)) {
    error = HrMessage("IAudioClient::SetEventHandle failed", hr);
    return false;
  }
  hr = client->GetService(IID_PPV_ARGS(&capture_));
  if (FAILED(hr)) {
    error = HrMessage("IAudioClient::GetService(IAudioCaptureClient) failed", hr);
    return false;
  }
  return true;
}

std::unique_ptr<CaptureStream> CaptureStream::OpenEndpoint(
  IMMDevice *device, bool loopback, double outputRate, std::string &error) {
  if (!device) {
    error = loopback ? "no audio output device" : "no audio input device";
    return nullptr;
  }
  std::unique_ptr<CaptureStream> stream(new CaptureStream());
  stream->outputRate_ = outputRate;
  HRESULT hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &stream->client_);
  if (FAILED(hr)) {
    error = HrMessage("IMMDevice::Activate(IAudioClient) failed", hr);
    return nullptr;
  }
  if (!stream->Initialize(stream->client_.Get(), loopback ? AUDCLNT_STREAMFLAGS_LOOPBACK : 0, nullptr, error)) {
    return nullptr;
  }
  return stream;
}

std::unique_ptr<CaptureStream> CaptureStream::OpenProcessLoopback(
  DWORD pid, bool include, double outputRate, std::string &error) {
  if (WindowsBuildNumber() < kProcessLoopbackMinBuild) {
    error = "per-app audio capture needs Windows 10 build 20348 or Windows 11";
    return nullptr;
  }
  AUDIOCLIENT_ACTIVATION_PARAMS params{};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode =
    include ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
  PROPVARIANT activation{};
  activation.vt = VT_BLOB;
  activation.blob.cbSize = sizeof(params);
  activation.blob.pBlobData = reinterpret_cast<BYTE *>(&params);

  ComPtr<ActivationHandler> handler = Microsoft::WRL::Make<ActivationHandler>();
  if (!handler || !handler->done()) {
    error = "failed to create the audio activation handler";
    return nullptr;
  }
  ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
  HRESULT hr = ActivateAudioInterfaceAsync(
    VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &activation, handler.Get(), &operation);
  if (FAILED(hr)) {
    error = HrMessage("ActivateAudioInterfaceAsync failed", hr);
    return nullptr;
  }
  if (WaitForSingleObject(handler->done(), 5000) != WAIT_OBJECT_0) {
    error = "process loopback activation timed out";
    return nullptr;
  }
  if (FAILED(handler->result())) {
    error = HrMessage("process loopback activation failed", handler->result());
    return nullptr;
  }
  std::unique_ptr<CaptureStream> stream(new CaptureStream());
  stream->outputRate_ = outputRate;
  stream->client_ = handler->client();
  // The process-loopback client has no mix format (GetMixFormat is
  // E_NOTIMPL); 48 kHz stereo Int16 is what it is known to accept.
  WAVEFORMATEX fallback{};
  fallback.wFormatTag = WAVE_FORMAT_PCM;
  fallback.nChannels = 2;
  fallback.nSamplesPerSec = 48000;
  fallback.wBitsPerSample = 16;
  fallback.nBlockAlign = 4;
  fallback.nAvgBytesPerSec = 48000 * 4;
  if (!stream->Initialize(stream->client_.Get(), AUDCLNT_STREAMFLAGS_LOOPBACK, &fallback, error)) {
    return nullptr;
  }
  return stream;
}

bool CaptureStream::Start(std::string &error) {
  const HRESULT hr = client_->Start();
  if (FAILED(hr)) {
    error = HrMessage("IAudioClient::Start failed", hr);
    return false;
  }
  started_ = true;
  return true;
}

HRESULT CaptureStream::Read(std::vector<int16_t> &out) {
  for (;;) {
    UINT32 packet = 0;
    HRESULT hr = capture_->GetNextPacketSize(&packet);
    if (FAILED(hr)) return hr;
    if (packet == 0) return S_OK;
    BYTE *data = nullptr;
    UINT32 frames = 0;
    DWORD flags = 0;
    hr = capture_->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
    if (FAILED(hr)) return hr;
    if (hr == AUDCLNT_S_BUFFER_EMPTY) return S_OK;
    const bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
    if (converter_) {
      converter_->Process(data, frames, silent, out);
    } else if (silent || !data) {
      out.insert(out.end(), frames, 0);
    } else {
      const size_t offset = out.size();
      out.resize(offset + frames);
      std::memcpy(out.data() + offset, data, frames * sizeof(int16_t));
    }
    hr = capture_->ReleaseBuffer(frames);
    if (FAILED(hr)) return hr;
  }
}

}  // namespace babelvoice
