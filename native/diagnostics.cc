#include "diagnostics.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <string>

#include "napi_util.h"

namespace babelvoice {

namespace {

struct DiagnosticsRegistry {
  NativeDiagnostics mic;
  NativeDiagnostics listen;
  NativeDiagnostics tts;
};

DiagnosticsRegistry &Registry() {
  static DiagnosticsRegistry *const registry = new DiagnosticsRegistry();
  return *registry;
}

}  // namespace

NativeDiagnostics &MicDiagnostics() { return Registry().mic; }
NativeDiagnostics &ListenDiagnostics() { return Registry().listen; }
NativeDiagnostics &TtsDiagnostics() { return Registry().tts; }

void SetRouteStatus(NativeDiagnostics &diag, const char *status) {
  std::lock_guard<std::mutex> lock(diag.textMutex);
  if (std::strncmp(diag.routeStatus, status ? status : "", sizeof(diag.routeStatus)) != 0) {
    CopyCString(diag.routeStatus, sizeof(diag.routeStatus), status);
  }
}

void SetLastError(NativeDiagnostics &diag, const char *message) {
  std::lock_guard<std::mutex> lock(diag.textMutex);
  CopyCString(diag.lastError, sizeof(diag.lastError), message);
}

double PcmLevel(const void *bytes, size_t length) {
  if (!bytes || length < sizeof(int16_t)) return 0.0;
  const int16_t *samples = static_cast<const int16_t *>(bytes);
  const size_t count = length / sizeof(int16_t);
  double sum = 0.0;
  for (size_t i = 0; i < count; i++) {
    const double s = static_cast<double>(samples[i]) / 32768.0;
    sum += s * s;
  }
  return std::sqrt(sum / std::max<size_t>(1, count));
}

void UpdateDiagnostics(NativeDiagnostics &diag, const void *bytes, size_t length, const char *routeStatus) {
  const uint64_t now = NowMs();
  const double level = PcmLevel(bytes, length);
  diag.level.store(level, std::memory_order_relaxed);
  diag.lastPcmAtMs.store(now, std::memory_order_relaxed);
  if (level < 0.01) {
    uint64_t expected = 0;
    diag.silenceStartedAtMs.compare_exchange_strong(expected, now, std::memory_order_relaxed);
  } else {
    diag.silenceStartedAtMs.store(0, std::memory_order_relaxed);
  }
  SetRouteStatus(diag, routeStatus);
}

napi_value MakeDiagnostics(napi_env env, NativeDiagnostics &diag) {
  napi_value obj;
  napi_create_object(env, &obj);
  SetNamed(env, obj, "level", MakeNumber(env, diag.level.load(std::memory_order_relaxed)));
  SetNamed(env, obj, "lastPcmAt", MakeNumber(env, static_cast<double>(diag.lastPcmAtMs.load(std::memory_order_relaxed))));
  const uint64_t silenceStartedAt = diag.silenceStartedAtMs.load(std::memory_order_relaxed);
  const uint64_t now = NowMs();
  const uint64_t silenceMs = silenceStartedAt == 0 || silenceStartedAt > now ? 0 : now - silenceStartedAt;
  SetNamed(env, obj, "silenceMs", MakeNumber(env, static_cast<double>(silenceMs)));
  SetNamed(env, obj, "queuedSamples", MakeNumber(env, static_cast<double>(diag.queuedSamples.load())));
  SetNamed(env, obj, "ringSamples", MakeNumber(env, static_cast<double>(diag.ringSamples.load())));
  SetNamed(env, obj, "droppedSamples", MakeNumber(env, static_cast<double>(diag.droppedSamples.load())));
  SetNamed(env, obj, "underruns", MakeNumber(env, static_cast<double>(diag.underruns.load())));
  std::string routeStatus;
  std::string lastError;
  {
    std::lock_guard<std::mutex> lock(diag.textMutex);
    routeStatus = diag.routeStatus;
    lastError = diag.lastError;
  }
  SetNamed(env, obj, "routeStatus", MakeString(env, routeStatus.c_str()));
  SetNamed(env, obj, "lastError", MakeString(env, lastError.c_str()));
  return obj;
}

napi_value GetAudioDiagnostics(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value obj;
  napi_create_object(env, &obj);
  SetNamed(env, obj, "mic", MakeDiagnostics(env, MicDiagnostics()));
  SetNamed(env, obj, "listen", MakeDiagnostics(env, ListenDiagnostics()));
  SetNamed(env, obj, "tts", MakeDiagnostics(env, TtsDiagnostics()));
  return obj;
}

}  // namespace babelvoice
