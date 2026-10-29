// Microphone capture: one shared AudioQueue fanned out to every consumer
// (JS PCM sinks at their own rate, the passthrough tee), plus the mic
// passthrough toggle. Objective-C++ only.
#pragma once

#include <node_api.h>

namespace babelvoice {

// startMicrophoneCapture(onPcm | null, deviceUid?, onError?, sampleRate?)
//   -> consumer id (number)
napi_value StartMicrophoneCapture(napi_env env, napi_callback_info info);
// stopMicrophoneCapture(consumerId?) -> true; no id stops every consumer.
napi_value StopMicrophoneCapture(napi_env env, napi_callback_info info);
// setMicPassthroughEnabled(enabled) -> true
napi_value SetMicPassthroughEnabled(napi_env env, napi_callback_info info);
// getMicrophoneCaptureState() -> { running, sampleRate, deviceUid, failed,
//   consumers, pcmConsumers, queueStarts, passthrough }
napi_value GetMicrophoneCaptureState(napi_env env, napi_callback_info info);

// JS thread, env teardown: stops the capture without releasing its TSFNs
// (Node frees them itself).
void StopMicrophoneForTeardown();

}  // namespace babelvoice
