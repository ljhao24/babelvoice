#include "promise_settler.h"

#include "napi_util.h"

namespace babelvoice {

namespace {

struct SettleResult {
  std::shared_ptr<PromiseSettler> settler;
  bool ok;
  std::string message;
};

void SettleJs(napi_env env, napi_value, void *, void *data) {
  std::unique_ptr<SettleResult> result(static_cast<SettleResult *>(data));
  if (!env || !result) return;  // env teardown: nobody is awaiting anymore
  PromiseSettler &settler = *result->settler;
  if (settler.onSettledJs) {
    std::function<void(bool)> hook = std::move(settler.onSettledJs);
    settler.onSettledJs = nullptr;
    hook(result->ok);
  }
  if (result->ok) {
    napi_value undefined;
    napi_get_undefined(env, &undefined);
    napi_resolve_deferred(env, settler.deferred, undefined);
  } else {
    napi_value message = MakeString(env, result->message.c_str());
    napi_value error;
    napi_create_error(env, nullptr, message, &error);
    napi_reject_deferred(env, settler.deferred, error);
  }
}

void SettlerTsfnFinalize(napi_env, void *data, void *) {
  std::unique_ptr<std::shared_ptr<PromiseSettler>> ref(static_cast<std::shared_ptr<PromiseSettler> *>(data));
  {
    std::lock_guard<std::mutex> lock((*ref)->mutex);
    (*ref)->tsfn = nullptr;
  }
  (*ref)->onSettledJs = nullptr;
}

}  // namespace

std::shared_ptr<PromiseSettler> CreateSettler(napi_env env, const char *name, napi_value *promise) {
  auto settler = std::make_shared<PromiseSettler>();
  napi_value resourceName;
  napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &resourceName);
  auto ref = std::make_unique<std::shared_ptr<PromiseSettler>>(settler);
  napi_threadsafe_function tsfn = nullptr;
  if (napi_create_threadsafe_function(
        env, nullptr, nullptr, resourceName, 0, 1, ref.get(), SettlerTsfnFinalize, nullptr, SettleJs, &tsfn) != napi_ok) {
    return nullptr;  // Node never runs the finalizer of a TSFN it failed to create
  }
  ref.release();  // owned by SettlerTsfnFinalize now
  if (napi_create_promise(env, &settler->deferred, promise) != napi_ok) {
    napi_release_threadsafe_function(tsfn, napi_tsfn_abort);
    return nullptr;
  }
  {
    std::lock_guard<std::mutex> lock(settler->mutex);
    settler->tsfn = tsfn;
  }
  return settler;
}

void Settle(const std::shared_ptr<PromiseSettler> &settler, bool ok, const std::string &message) {
  auto result = std::make_unique<SettleResult>(SettleResult{settler, ok, message});
  std::lock_guard<std::mutex> lock(settler->mutex);
  if (!settler->tsfn) return;
  if (napi_call_threadsafe_function(settler->tsfn, result.get(), napi_tsfn_nonblocking) == napi_ok) {
    result.release();  // SettleJs owns it now
  }
  napi_release_threadsafe_function(settler->tsfn, napi_tsfn_release);
  settler->tsfn = nullptr;
}

}  // namespace babelvoice
