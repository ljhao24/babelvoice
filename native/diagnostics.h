// Per-route audio diagnostics (mic / listen / tts) surfaced to JS through
// getAudioDiagnostics(). Pure C++.
#pragma once

#include <node_api.h>

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <mutex>

namespace babelvoice {

// Written by capture threads, read by the JS thread — every numeric field is
// atomic so diagnostics polling is not a data race. The strings have writers
// on several threads too, so they go through SetRouteStatus / SetLastError
// under `textMutex` (a leaf lock: never held while taking another one, never
// taken on a HAL IO thread).
struct NativeDiagnostics {
  std::atomic<double> level{0.0};
  std::atomic<uint64_t> lastPcmAtMs{0};
  std::atomic<uint64_t> silenceStartedAtMs{0};
  std::atomic<uint64_t> queuedSamples{0};
  std::atomic<uint64_t> ringSamples{0};
  std::atomic<uint64_t> droppedSamples{0};
  std::atomic<uint64_t> underruns{0};
  std::mutex textMutex;
  char routeStatus[128] = "idle";  // guarded by textMutex
  char lastError[256] = "";        // guarded by textMutex
};

// The three routes. Process-lifetime singletons (never destroyed, so a late
// producer thread at exit can't touch a destroyed mutex).
NativeDiagnostics &MicDiagnostics();
NativeDiagnostics &ListenDiagnostics();
NativeDiagnostics &TtsDiagnostics();

void SetRouteStatus(NativeDiagnostics &diag, const char *status);
void SetLastError(NativeDiagnostics &diag, const char *message);

// RMS of Int16 PCM, 0..1.
double PcmLevel(const void *bytes, size_t length);

// Called once per chunk by the (single) producer of `diag`. Not for HAL IO
// threads — the tap's pump thread calls it instead of the IOProc.
void UpdateDiagnostics(NativeDiagnostics &diag, const void *bytes, size_t length, const char *routeStatus);

napi_value MakeDiagnostics(napi_env env, NativeDiagnostics &diag);

// getAudioDiagnostics() -> { mic, listen, tts }
napi_value GetAudioDiagnostics(napi_env env, napi_callback_info info);

}  // namespace babelvoice
