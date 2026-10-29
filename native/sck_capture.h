// System audio capture through ScreenCaptureKit. Objective-C++ only.
#pragma once

#include <node_api.h>

namespace babelvoice {

// startSystemAudioCapture(onPcm, onError?, sampleRate?) -> Promise<void>
napi_value StartSystemAudioCapture(napi_env env, napi_callback_info info);
// stopSystemAudioCapture() -> Promise<void>
napi_value StopSystemAudioCapture(napi_env env, napi_callback_info info);

// JS thread, env teardown (TSFN finalizer / CleanupNativeBridge): never
// releases the TSFNs; the stream is stopped asynchronously.
void StopSystemAudioForTeardown();

}  // namespace babelvoice
