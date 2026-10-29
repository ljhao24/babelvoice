// TTS output to the virtual loopback device: HAL AudioUnit + FIFO feeder +
// lock-free SPSC ring, plus the mic-passthrough tee's entry point into it.
// Objective-C++ only.
#pragma once

#include <node_api.h>

#include <cstddef>
#include <cstdint>

namespace babelvoice {

// --- Mic passthrough tee (state lives with the output it feeds). ---
//
// While the flag is set the mic capture tees raw mic PCM into the TTS queue
// (TeeMicToTtsQueue) and the render callback plays it through a jitter
// buffer, so the virtual loopback device keeps emitting the speaker's voice
// while no translation session runs.

// Any thread.
bool MicPassthroughEnabled();
// Any thread.
void SetMicPassthroughFlag(bool enabled);
// Any thread. Clears the flag; true when it was set.
bool ClearMicPassthroughFlag();
// Any thread. Start passthrough playback from a filled jitter buffer rather
// than an empty ring.
void ArmTtsPrebuffer();

// AudioQueue thread. Never throws; under back-pressure it drops the *oldest*
// audio so the meeting hears the speaker with a bounded delay instead of
// keeping whatever lag a stalled device built up. Samples are copied into
// the TTS queue verbatim, so they are dropped unless the output unit runs at
// `sampleRate` (else the meeting would hear the voice pitch-shifted).
void TeeMicToTtsQueue(const int16_t *src, size_t sampleCount, double sampleRate);

// JS thread. Rate of the prepared output unit; 0 when there is none.
double TtsUnitSampleRate();

// JS thread. Discard everything queued or in the ring.
void FlushTtsOutputUnit();

// JS thread, env teardown.
void DisposeTtsOutput();

// prepareTtsOutput(sampleRate?, devicePattern?) -> true
napi_value PrepareTtsOutput(napi_env env, napi_callback_info info);
// playPcm(buffer, sampleRate?, devicePattern?) -> true
napi_value PlayPcm(napi_env env, napi_callback_info info);
// closeTtsOutput() -> true
napi_value CloseTtsOutput(napi_env env, napi_callback_info info);
// flushTtsOutput() -> true
napi_value FlushTtsOutput(napi_env env, napi_callback_info info);
// getTtsPendingMs() -> number
napi_value GetTtsPendingMs(napi_env env, napi_callback_info info);

}  // namespace babelvoice
