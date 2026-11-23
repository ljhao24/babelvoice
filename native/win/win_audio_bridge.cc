// BabelVoice Windows native bridge: module registration, capability /
// permission queries, subtitle-window styling and env-teardown cleanup.
// Exposes the same NativeAddon surface as macos_audio_bridge.mm.
//
// The subsystems live in their own files:
//   ../napi_util, ../diagnostics, ../capture_sink, ../promise_settler
//                         shared with macOS (plain C++)
//   win_common            COM scoping, string conversion
//   win_devices           MMDevice endpoints, virtual-cable policy,
//                         topology notifications, mic privacy setting
//   win_pcm               resampler + capture format conversion
//   win_capture_stream    one WASAPI capture stream (endpoint / loopback /
//                         process loopback)
//   win_tts_output        TTS render stream to VB-Cable, passthrough tee
//   win_mic_capture       shared microphone capture fanned out to consumers
//   win_loopback_capture  system audio and per-app audio
#include <node_api.h>

#include "../diagnostics.h"
#include "../mic_capture.h"
#include "../napi_util.h"
#include "../process_tap.h"
#include "../sck_capture.h"
#include "../tts_output.h"
#include "win_capture_stream.h"
#include "win_common.h"
#include "win_devices.h"

namespace babelvoice {

namespace {

napi_value GetCapabilities(napi_env env, napi_callback_info info) {
  (void)info;
  ScopedCom com(COINIT_APARTMENTTHREADED);
  napi_value obj;
  napi_create_object(env, &obj);
  SetNamed(env, obj, "platform", MakeString(env, "win32"));
  SetNamed(env, obj, "systemAudioCapture", MakeBool(env, true));
  SetNamed(env, obj, "nativeTtsPlayback", MakeBool(env, true));
  SetNamed(env, obj, "processAudioCapture", MakeBool(env, WindowsBuildNumber() >= kProcessLoopbackMinBuild));
  SetNamed(env, obj, "microphoneCapture", MakeBool(env, true));
  SetNamed(env, obj, "audioDevices", MakeBool(env, true));
  SetNamed(env, obj, "permissions", MakeBool(env, true));
  SetNamed(env, obj, "windowBehavior", MakeBool(env, true));
  SetNamed(env, obj, "hasVirtualOutput", MakeBool(env, HasVirtualOutputCached()));
  return obj;
}

// Windows has no screen-recording / input-monitoring / accessibility gates
// for what we do; only the microphone privacy switch matters.
napi_value GetPermissions(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value obj;
  napi_create_object(env, &obj);
  SetNamed(env, obj, "screen", MakeString(env, "granted"));
  SetNamed(env, obj, "microphone", MakeString(env, MicrophonePermissionStatus()));
  SetNamed(env, obj, "inputMonitoring", MakeString(env, "granted"));
  SetNamed(env, obj, "accessibility", MakeString(env, "granted"));
  return obj;
}

// Keeps the subtitle overlay above full-screen meeting windows and out of
// the taskbar / Alt+Tab.
napi_value ConfigureSubtitleWindow(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1) {
    Throw(env, "configureSubtitleWindow requires a native window handle buffer");
    return nullptr;
  }
  bool isBuffer = false;
  napi_is_buffer(env, args[0], &isBuffer);
  if (!isBuffer) {
    Throw(env, "native window handle must be a Buffer");
    return nullptr;
  }
  void *handleBytes = nullptr;
  size_t handleLength = 0;
  napi_get_buffer_info(env, args[0], &handleBytes, &handleLength);
  if (!handleBytes || handleLength < sizeof(HWND)) {
    Throw(env, "native window handle buffer is invalid");
    return nullptr;
  }
  HWND hwnd = *reinterpret_cast<HWND *>(handleBytes);
  if (!IsWindow(hwnd)) return MakeBool(env, true);
  const LONG_PTR exStyle = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (exStyle | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW);
  SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED);
  return MakeBool(env, true);
}

void CleanupNativeBridge(void *) {
  // Stop every worker thread before Node frees the TSFNs they post to.
  StopMicrophoneForTeardown();
  StopSystemAudioForTeardown();
  StopProcessTapForTeardown();
  DisposeTtsOutput();
  ReleaseDeviceNotifications();
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor descriptors[] = {
    {"getCapabilities", nullptr, GetCapabilities, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"getPermissions", nullptr, GetPermissions, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"listAudioDevices", nullptr, ListAudioDevices, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"getAudioDiagnostics", nullptr, GetAudioDiagnostics, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"startMicrophoneCapture", nullptr, StartMicrophoneCapture, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"stopMicrophoneCapture", nullptr, StopMicrophoneCapture, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"startSystemAudioCapture", nullptr, StartSystemAudioCapture, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"stopSystemAudioCapture", nullptr, StopSystemAudioCapture, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"listAudioCapableApplications", nullptr, ListAudioCapableApplications, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"startProcessAudioCapture", nullptr, StartProcessAudioCapture, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"stopProcessAudioCapture", nullptr, StopProcessAudioCapture, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"prepareTtsOutput", nullptr, PrepareTtsOutput, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"playPcm", nullptr, PlayPcm, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"flushTtsOutput", nullptr, FlushTtsOutput, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"getTtsPendingMs", nullptr, GetTtsPendingMs, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"closeTtsOutput", nullptr, CloseTtsOutput, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"setMicPassthroughEnabled", nullptr, SetMicPassthroughEnabled, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"getMicrophoneCaptureState", nullptr, GetMicrophoneCaptureState, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"configureSubtitleWindow", nullptr, ConfigureSubtitleWindow, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  napi_define_properties(env, exports, sizeof(descriptors) / sizeof(descriptors[0]), descriptors);
  napi_add_env_cleanup_hook(env, CleanupNativeBridge, nullptr);
  return exports;
}

}  // namespace

}  // namespace babelvoice

NAPI_MODULE(NODE_GYP_MODULE_NAME, babelvoice::Init)
