#include "capture_sink.h"

#include <cstdlib>
#include <cstring>

#include "napi_util.h"

namespace babelvoice {

void FreePacket(PcmPacket *packet) {
  if (!packet) return;
  std::free(packet->bytes);
  std::free(packet);
}

PcmPacketPtr AllocPacket(size_t length) {
  PcmPacketPtr packet(static_cast<PcmPacket *>(std::malloc(sizeof(PcmPacket))));
  if (!packet) return nullptr;
  packet->length = length;
  packet->bytes = std::malloc(length);
  if (!packet->bytes) return nullptr;  // deleter frees the header
  return packet;
}

PcmPacketPtr CopyPacket(const void *bytes, size_t length) {
  PcmPacketPtr packet = AllocPacket(length);
  if (packet) std::memcpy(packet->bytes, bytes, length);
  return packet;
}

namespace {

// TSFN call_js callbacks. `env` is null when Node drains the queue of a TSFN
// that is being torn down — only free the payload then.
void CallPcmJs(napi_env env, napi_value jsCallback, void *, void *data) {
  PcmPacketPtr packet(static_cast<PcmPacket *>(data));
  if (env && jsCallback && packet) {
    napi_value buffer;
    void *copy = nullptr;
    napi_create_buffer_copy(env, packet->length, packet->bytes, &copy, &buffer);
    napi_value undefined;
    napi_get_undefined(env, &undefined);
    napi_call_function(env, undefined, jsCallback, 1, &buffer, nullptr);
  }
}

void CallErrorJs(napi_env env, napi_value jsCallback, void *, void *data) {
  char *message = static_cast<char *>(data);
  if (env && jsCallback && message) {
    napi_value arg = MakeString(env, message);
    napi_value undefined;
    napi_get_undefined(env, &undefined);
    napi_call_function(env, undefined, jsCallback, 1, &arg, nullptr);
  }
  std::free(message);
}

struct SinkFinalizeData {
  std::shared_ptr<CaptureSink> sink;
  StopIfCurrentFn stopIfCurrent;
};

// thread_finalize_cb — JS thread, right before Node frees the TSFN. After a
// normal stop the capture is no longer current and this is a no-op. During
// env teardown it is our last chance to stop the producer threads while the
// TSFN still exists; env cleanup hooks run in reverse registration order, so
// this may well run before CleanupNativeBridge.
void SinkTsfnFinalize(napi_env, void *data, void *) {
  std::unique_ptr<SinkFinalizeData> finalizeData(static_cast<SinkFinalizeData *>(data));
  finalizeData->stopIfCurrent(finalizeData->sink.get());
  finalizeData->sink->Detach();
}

bool CreateSinkTsfn(
  napi_env env,
  napi_value fn,
  const char *name,
  napi_threadsafe_function_call_js callJs,
  const std::shared_ptr<CaptureSink> &sink,
  StopIfCurrentFn stopIfCurrent,
  napi_threadsafe_function *out
) {
  napi_value resourceName;
  napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &resourceName);
  auto finalizeData = std::make_unique<SinkFinalizeData>(SinkFinalizeData{sink, stopIfCurrent});
  const napi_status status = napi_create_threadsafe_function(
    env, fn, nullptr, resourceName, 0, 1, finalizeData.get(), SinkTsfnFinalize, nullptr, callJs, out);
  if (status != napi_ok) {
    // Node never runs the finalizer of a TSFN it failed to create.
    *out = nullptr;
    return false;
  }
  finalizeData.release();  // owned by the TSFN finalizer now
  return true;
}

}  // namespace

void CaptureSink::PostPcm(PcmPacketPtr packet) {
  if (!packet) return;
  std::lock_guard<std::mutex> lock(mutex);
  if (pcm && !stopping &&
      napi_call_threadsafe_function(pcm, packet.get(), napi_tsfn_nonblocking) == napi_ok) {
    packet.release();  // CallPcmJs owns it now
  }
}

void CaptureSink::PostError(const char *message) {
  std::lock_guard<std::mutex> lock(mutex);
  PostErrorLocked(message);
}

void CaptureSink::PostErrorLocked(const char *message) {
  if (!error || stopping || errorReported) return;
  errorReported = true;
  char *copy = strdup(message && *message ? message : "audio capture stopped unexpectedly");
  if (copy && napi_call_threadsafe_function(error, copy, napi_tsfn_nonblocking) != napi_ok) {
    std::free(copy);
  }
}

void CaptureSink::BeginStop() {
  accepting.store(false, std::memory_order_release);
  std::lock_guard<std::mutex> lock(mutex);
  stopping = true;
}

void CaptureSink::Release() {
  accepting.store(false, std::memory_order_release);
  napi_threadsafe_function pcmHandle = nullptr;
  napi_threadsafe_function errorHandle = nullptr;
  {
    std::lock_guard<std::mutex> lock(mutex);
    stopping = true;
    pcmHandle = pcm;
    errorHandle = error;
    pcm = nullptr;
    error = nullptr;
  }
  if (pcmHandle) napi_release_threadsafe_function(pcmHandle, napi_tsfn_abort);
  if (errorHandle) napi_release_threadsafe_function(errorHandle, napi_tsfn_abort);
}

void CaptureSink::Detach() {
  accepting.store(false, std::memory_order_release);
  std::lock_guard<std::mutex> lock(mutex);
  stopping = true;
  pcm = nullptr;
  error = nullptr;
}

std::shared_ptr<CaptureSink> CreateCaptureSink(
  napi_env env,
  napi_value onPcm,
  napi_value onError,
  const char *name,
  StopIfCurrentFn stopIfCurrent
) {
  auto sink = std::make_shared<CaptureSink>();
  napi_threadsafe_function pcm = nullptr;
  napi_threadsafe_function error = nullptr;
  if (onPcm && !CreateSinkTsfn(env, onPcm, name, CallPcmJs, sink, stopIfCurrent, &pcm)) return nullptr;
  if (onError && !CreateSinkTsfn(env, onError, name, CallErrorJs, sink, stopIfCurrent, &error)) {
    if (pcm) napi_release_threadsafe_function(pcm, napi_tsfn_abort);
    return nullptr;
  }
  {
    std::lock_guard<std::mutex> lock(sink->mutex);
    sink->pcm = pcm;
    sink->error = error;
  }
  return sink;
}

}  // namespace babelvoice
