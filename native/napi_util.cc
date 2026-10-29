#include "napi_util.h"

#include <time.h>

#include <cstdio>

namespace babelvoice {

napi_value MakeString(napi_env env, const char *value) {
  napi_value out;
  napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &out);
  return out;
}

napi_value MakeBool(napi_env env, bool value) {
  napi_value out;
  napi_get_boolean(env, value, &out);
  return out;
}

napi_value MakeNumber(napi_env env, double value) {
  napi_value out;
  napi_create_double(env, value, &out);
  return out;
}

void Throw(napi_env env, const char *message) {
  napi_throw_error(env, nullptr, message);
}

void SetNamed(napi_env env, napi_value obj, const char *name, napi_value value) {
  napi_set_named_property(env, obj, name, value);
}

std::string StringArg(napi_env env, napi_value value) {
  size_t len = 0;
  napi_get_value_string_utf8(env, value, nullptr, 0, &len);
  std::string out(len + 1, '\0');
  size_t written = 0;
  napi_get_value_string_utf8(env, value, out.data(), len + 1, &written);
  out.resize(written);
  return out;
}

napi_value OptionalFunctionArg(napi_env env, const napi_value *args, size_t argc, size_t index) {
  if (index >= argc) return nullptr;
  napi_valuetype type;
  if (napi_typeof(env, args[index], &type) != napi_ok || type != napi_function) return nullptr;
  return args[index];
}

bool CaptureSampleRateArg(napi_env env, const napi_value *args, size_t argc, size_t index, double &out) {
  out = kDefaultCaptureSampleRate;
  if (index >= argc) return true;
  napi_valuetype type;
  if (napi_typeof(env, args[index], &type) != napi_ok || type == napi_undefined) return true;
  double rate = 0;
  if (type != napi_number || napi_get_value_double(env, args[index], &rate) != napi_ok ||
      (rate != 16000 && rate != 24000)) {
    Throw(env, "capture sampleRate must be 16000 or 24000");
    return false;
  }
  out = rate;
  return true;
}

bool TtsSampleRateArg(napi_env env, const napi_value *args, size_t argc, size_t index, double &out) {
  out = kDefaultCaptureSampleRate;
  if (index >= argc) return true;
  napi_valuetype type;
  if (napi_typeof(env, args[index], &type) != napi_ok || type == napi_undefined) return true;
  int32_t rate = 0;
  if (napi_get_value_int32(env, args[index], &rate) != napi_ok || (rate != 16000 && rate != 24000)) {
    Throw(env, "TTS sampleRate must be 16000 or 24000");
    return false;
  }
  out = rate;
  return true;
}

uint64_t NowMs() {
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  return static_cast<uint64_t>(ts.tv_sec) * 1000u + static_cast<uint64_t>(ts.tv_nsec / 1000000);
}

void CopyCString(char *dst, size_t dstLen, const char *src) {
  if (dstLen == 0) return;
  std::snprintf(dst, dstLen, "%s", src ? src : "");
}

}  // namespace babelvoice
