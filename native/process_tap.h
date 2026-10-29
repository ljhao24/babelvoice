// Per-application audio capture through a Core Audio Process Tap (macOS
// 14.4+). Objective-C++ only.
#pragma once

#include <node_api.h>

namespace babelvoice {

// listAudioCapableApplications() -> { pid, bundleId, name }[]
napi_value ListAudioCapableApplications(napi_env env, napi_callback_info info);
// startProcessAudioCapture(bundleId, onPcm, onError?, sampleRate?) -> Promise<void>
napi_value StartProcessAudioCapture(napi_env env, napi_callback_info info);
// stopProcessAudioCapture() -> Promise<void>
napi_value StopProcessAudioCapture(napi_env env, napi_callback_info info);

// JS thread, env teardown: detaches the TSFNs; the HAL teardown stays queued
// on TapQueue and never touches a TSFN.
void StopProcessTapForTeardown();

}  // namespace babelvoice
