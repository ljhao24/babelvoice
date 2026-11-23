// One shared-mode WASAPI capture stream delivering mono Int16 at a fixed
// rate: a microphone endpoint, an endpoint in loopback mode (system audio),
// or a process-loopback virtual device (one app's audio tree, or everything
// but our own). Owned and driven by a single worker thread with COM
// initialized (MTA); nothing here is thread-safe.
#pragma once

#include "win_common.h"
#include "win_pcm.h"

#include <audioclient.h>
#include <mmdeviceapi.h>

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace babelvoice {

class CaptureStream {
 public:
  ~CaptureStream();

  // Endpoint capture (microphone), or the endpoint's render mix when
  // `loopback` is set.
  static std::unique_ptr<CaptureStream> OpenEndpoint(
    IMMDevice *device, bool loopback, double outputRate, std::string &error);

  // Process loopback (Windows 10 build 20348+): `pid`'s process tree when
  // `include`, else everything except that tree.
  static std::unique_ptr<CaptureStream> OpenProcessLoopback(
    DWORD pid, bool include, double outputRate, std::string &error);

  bool Start(std::string &error);

  // Signalled when packets are ready.
  HANDLE event() const { return event_; }

  // Appends every pending packet, converted, to `out`. Returns the first
  // failing HRESULT (AUDCLNT_E_DEVICE_INVALIDATED when the device went away).
  HRESULT Read(std::vector<int16_t> &out);

  double outputRate() const { return outputRate_; }

 private:
  CaptureStream() = default;
  bool Initialize(IAudioClient *client, DWORD extraFlags, const WAVEFORMATEX *fallback, std::string &error);

  ComPtr<IAudioClient> client_;
  ComPtr<IAudioCaptureClient> capture_;
  HANDLE event_ = nullptr;
  double outputRate_ = 0;
  // null: WASAPI already delivers mono Int16 at outputRate_.
  std::unique_ptr<CaptureConverter> converter_;
  bool started_ = false;
};

// Windows build that introduced process loopback.
constexpr DWORD kProcessLoopbackMinBuild = 20348;

}  // namespace babelvoice
