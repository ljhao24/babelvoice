// JS callback plumbing shared by every capture (thread-safe functions).
// Pure C++.
//
// Producers run on threads we don't own (AudioQueue thread, SCK sample queue,
// tap pump thread, CoreAudio listener queue). Node frees a TSFN once it is
// released *or* when the env is torn down at quit, and calling a freed TSFN
// is a use-after-free. So producers never hold a raw TSFN: they post through
// a CaptureSink whose handles are only nulled under `mutex` — by stop() on
// the JS thread, or by the TSFN's own finalizer during env teardown (which
// also stops the producers; see SinkTsfnFinalize).
#pragma once

#include <node_api.h>

#include <atomic>
#include <cstddef>
#include <memory>
#include <mutex>

namespace babelvoice {

// One chunk of Int16 PCM on its way to JS. malloc'd so it can cross the
// TSFN as a plain pointer; CallPcmJs frees it on the JS thread.
struct PcmPacket {
  void *bytes;
  size_t length;
};

void FreePacket(PcmPacket *packet);

struct PcmPacketDeleter {
  void operator()(PcmPacket *packet) const { FreePacket(packet); }
};
using PcmPacketPtr = std::unique_ptr<PcmPacket, PcmPacketDeleter>;

// Uninitialized `length` bytes; null on allocation failure.
PcmPacketPtr AllocPacket(size_t length);
PcmPacketPtr CopyPacket(const void *bytes, size_t length);

struct CaptureSink {
  std::mutex mutex;
  napi_threadsafe_function pcm = nullptr;    // guarded by mutex
  napi_threadsafe_function error = nullptr;  // guarded by mutex; optional
  bool stopping = false;                     // guarded by mutex
  bool errorReported = false;                // guarded by mutex
  bool failed = false;                       // guarded by mutex; see Fail
  // Lock-free hint so producers can skip work once stopping; PostPcm
  // re-checks under the lock.
  std::atomic_bool accepting{true};

  // Any producer thread. Hands the packet to JS, or frees it.
  void PostPcm(PcmPacketPtr packet);

  // onError fires at most once per capture and never once stop has begun.
  void PostError(const char *message);

  // PostError that first marks the capture failed and runs `onFailed`, both
  // under the lock and only while the capture is live — so a listener block
  // that outlived its capture can't touch state a newer capture now owns
  // (BeginStop waits for it).
  template <typename Fn>
  void Fail(const char *message, Fn &&onFailed) {
    std::lock_guard<std::mutex> lock(mutex);
    if (stopping) return;
    failed = true;
    onFailed();
    PostErrorLocked(message);
  }

  // Runs `fn` under the lock iff the capture is live and hasn't failed, so
  // nothing done by `fn` can land after (and undo) a Fail.
  template <typename Fn>
  bool IfHealthy(Fn &&fn) {
    std::lock_guard<std::mutex> lock(mutex);
    if (stopping || failed) return false;
    fn();
    return true;
  }

  void PostErrorLocked(const char *message);

  // Nothing reaches JS from here on. Called before we stop the producers so
  // our own teardown (queue stop, device destroy) isn't reported as a failure.
  void BeginStop();

  // Normal stop, JS thread: drop and release both TSFNs. Abort discards
  // anything still queued, so no PCM/error is delivered after stop().
  void Release();

  // Env teardown: Node frees the TSFNs itself; only make sure nobody touches
  // them again. Never calls into N-API.
  void Detach();
};

// Synchronously stops the capture owning `sink` if it is still the active
// one (JS thread; must not release TSFNs — Node is freeing them).
using StopIfCurrentFn = void (*)(CaptureSink *sink);

// JS thread. onPcm (nullable only for the mic: passthrough has no PCM
// consumer) receives the PCM; onError (nullable) receives a message string
// when the capture dies on its own. With neither, CleanupNativeBridge alone
// stops the producers at env teardown — they then never touch a TSFN anyway.
// nullptr when a TSFN couldn't be created.
std::shared_ptr<CaptureSink> CreateCaptureSink(
  napi_env env,
  napi_value onPcm,
  napi_value onError,
  const char *name,
  StopIfCurrentFn stopIfCurrent);

}  // namespace babelvoice
