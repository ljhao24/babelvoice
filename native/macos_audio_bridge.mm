// BabelVoice macOS native bridge: module registration, capability /
// permission queries, subtitle-window styling and env-teardown cleanup.
//
// The subsystems live in their own files:
//   napi_util       N-API value helpers, argument parsing
//   diagnostics     per-route diagnostics (getAudioDiagnostics)
//   devices         device queries, virtual-device policy, property listeners
//   capture_sink    TSFN plumbing every capture posts PCM / errors through
//   promise_settler promise settling from any thread
//   tts_output      TTS AudioUnit + ring + feeder, mic passthrough tee target
//   pcm_resampler   allocation-free Int16 SRC for mic consumers
//   mic_capture     shared microphone AudioQueue fanned out to consumers,
//                   passthrough toggle
//   sck_capture     ScreenCaptureKit system audio
//   process_tap     Core Audio Process Tap per-app capture
#include <node_api.h>

#import <AVFoundation/AVFoundation.h>
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>

#include "devices.h"
#include "diagnostics.h"
#include "mic_capture.h"
#include "napi_util.h"
#include "process_tap.h"
#include "sck_capture.h"
#include "tts_output.h"

namespace babelvoice {
namespace {

napi_value GetCapabilities(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value obj;
  napi_create_object(env, &obj);
  SetNamed(env, obj, "platform", MakeString(env, "darwin"));
  SetNamed(env, obj, "minimumMacOS", MakeString(env, "14.0"));

  bool supported = false;
  const char *reason = "";
  if (@available(macOS 14.0, *)) {
    supported = true;
  } else {
    reason = "macOS 14.0 or newer is required";
  }
  bool processTapSupported = false;
  if (@available(macOS 14.4, *)) {
    processTapSupported = true;
  }
  SetNamed(env, obj, "systemAudioCapture", MakeBool(env, supported));
  SetNamed(env, obj, "nativeTtsPlayback", MakeBool(env, supported));
  SetNamed(env, obj, "processAudioCapture", MakeBool(env, processTapSupported));
  SetNamed(env, obj, "microphoneCapture", MakeBool(env, true));
  SetNamed(env, obj, "audioDevices", MakeBool(env, true));
  SetNamed(env, obj, "permissions", MakeBool(env, true));
  SetNamed(env, obj, "windowBehavior", MakeBool(env, true));
  SetNamed(env, obj, "hasVirtualOutput", MakeBool(env, HasVirtualOutputCached()));
  if (!supported) SetNamed(env, obj, "reason", MakeString(env, reason));
  return obj;
}

napi_value GetPermissions(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value obj;
  napi_create_object(env, &obj);
  SetNamed(env, obj, "screen", MakeString(env, CGPreflightScreenCaptureAccess() ? "granted" : "denied"));
  AVAuthorizationStatus mic = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
  const char *micStatus = "unknown";
  if (mic == AVAuthorizationStatusAuthorized) micStatus = "granted";
  else if (mic == AVAuthorizationStatusDenied) micStatus = "denied";
  else if (mic == AVAuthorizationStatusRestricted) micStatus = "restricted";
  else if (mic == AVAuthorizationStatusNotDetermined) micStatus = "not-determined";
  SetNamed(env, obj, "microphone", MakeString(env, micStatus));
  SetNamed(env, obj, "inputMonitoring", MakeString(env, CGPreflightListenEventAccess() ? "granted" : "denied"));
  SetNamed(env, obj, "accessibility", MakeString(env, AXIsProcessTrusted() ? "granted" : "denied"));
  return obj;
}

napi_value ConfigureSubtitleWindow(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
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
  if (!handleBytes || handleLength < sizeof(void *)) {
    Throw(env, "native window handle buffer is invalid");
    return nullptr;
  }
  void *nativePtr = *reinterpret_cast<void **>(handleBytes);
  void (^configure)(void) = ^{
    id nativeObject = (__bridge id)nativePtr;
    NSWindow *window = nil;
    if ([nativeObject isKindOfClass:[NSWindow class]]) {
      window = (NSWindow *)nativeObject;
    } else if ([nativeObject isKindOfClass:[NSView class]]) {
      window = [(NSView *)nativeObject window];
    }
    if (!window) return;
    window.level = NSFloatingWindowLevel;
    window.collectionBehavior =
      NSWindowCollectionBehaviorCanJoinAllSpaces |
      NSWindowCollectionBehaviorFullScreenAuxiliary |
      NSWindowCollectionBehaviorStationary;
    window.movableByWindowBackground = YES;
    window.hasShadow = NO;
  };
  if ([NSThread isMainThread]) {
    configure();
  } else {
    dispatch_sync(dispatch_get_main_queue(), configure);
  }
  return MakeBool(env, true);
}

void CleanupNativeBridge(void *) {
  // Stop every producer thread before Node frees the TSFNs they post to.
  // Handles are detached, never released, here: the TSFNs' own cleanup hooks
  // (registered later, so run earlier) already closed them and Node frees
  // them. A pending start promise settle is harmless — a call into a closing
  // TSFN just returns napi_closing. The process tap is only detached here;
  // its HAL teardown stays queued on TapQueue and never touches a TSFN.
  StopMicrophoneForTeardown();
  StopSystemAudioForTeardown();
  StopProcessTapForTeardown();
  DisposeTtsOutput();
  ReleaseDeviceTopologyListeners();
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
