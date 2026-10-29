// Settles one JS promise from any thread (SCK completion handlers, TapQueue,
// timeouts). The first Settle() wins; later ones are ignored. Pure C++.
#pragma once

#include <node_api.h>

#include <functional>
#include <memory>
#include <mutex>
#include <string>

namespace babelvoice {

struct PromiseSettler {
  std::mutex mutex;
  napi_threadsafe_function tsfn = nullptr;  // guarded by mutex; one-shot
  napi_deferred deferred = nullptr;         // JS thread only
  // JS thread only; runs right before the promise settles.
  std::function<void(bool ok)> onSettledJs;
};

// JS thread. nullptr (nothing to clean up) on failure.
std::shared_ptr<PromiseSettler> CreateSettler(napi_env env, const char *name, napi_value *promise);

// Any thread.
void Settle(const std::shared_ptr<PromiseSettler> &settler, bool ok, const std::string &message);

}  // namespace babelvoice
