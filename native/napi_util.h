// N-API value helpers and argument parsing shared by every subsystem of the
// native bridge. Pure C++ (no Objective-C), JS thread only unless noted.
#pragma once

#include <node_api.h>

#include <cstddef>
#include <cstdint>
#include <string>

namespace babelvoice {

napi_value MakeString(napi_env env, const char *value);
napi_value MakeBool(napi_env env, bool value);
napi_value MakeNumber(napi_env env, double value);
void Throw(napi_env env, const char *message);
void SetNamed(napi_env env, napi_value obj, const char *name, napi_value value);

std::string StringArg(napi_env env, napi_value value);
// args[index] when it is a function, else nullptr.
napi_value OptionalFunctionArg(napi_env env, const napi_value *args, size_t argc, size_t index);

// Capture output rates a TranslationClient may ask for: 16 kHz for most
// engines, 24 kHz for OpenAI realtime translation. Every capture resamples
// in the OS (AudioQueue / ScreenCaptureKit / AudioConverter), so any rate
// works technically; the allow-list just catches a garbage argument.
constexpr double kDefaultCaptureSampleRate = 16000;

// Optional trailing `sampleRate` argument of the capture starts. Absent or
// undefined → 16 kHz. Returns false (after throwing) on an unsupported rate.
bool CaptureSampleRateArg(napi_env env, const napi_value *args, size_t argc, size_t index, double &out);

// `sampleRate` argument of prepareTtsOutput / playPcm. Absent or undefined →
// 16 kHz. TTS rates in use are 16 kHz (Doubao) and 24 kHz (Qwen / Gemini /
// OpenAI, mic passthrough); anything else is a caller bug that would
// otherwise build an AudioUnit at a garbage rate. Throws and returns false
// on a non-integer or unsupported rate.
bool TtsSampleRateArg(napi_env env, const napi_value *args, size_t argc, size_t index, double &out);

// Wall-clock ms, comparable with JS Date.now(). clock_gettime is a commpage
// read: no ObjC, no allocation, safe on any thread.
uint64_t NowMs();

// Any thread. Truncating, always NUL-terminated (when dstLen > 0).
void CopyCString(char *dst, size_t dstLen, const char *src);

}  // namespace babelvoice
