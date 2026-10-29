// RAII owner for a Core Foundation reference obtained under the Create /
// Copy rule (or a "retained" out-parameter).
#pragma once

#include <CoreFoundation/CoreFoundation.h>

namespace babelvoice {

template <typename T>
class ScopedCFRef {
 public:
  ScopedCFRef() = default;
  explicit ScopedCFRef(T ref) : ref_(ref) {}
  ~ScopedCFRef() { Reset(); }
  ScopedCFRef(const ScopedCFRef &) = delete;
  ScopedCFRef &operator=(const ScopedCFRef &) = delete;

  T get() const { return ref_; }
  explicit operator bool() const { return ref_ != nullptr; }
  // For "…WithRetained…(…, &out)" style APIs. Releases what was held.
  T *Out() {
    Reset();
    return &ref_;
  }
  void Reset(T ref = nullptr) {
    if (ref_) CFRelease(ref_);
    ref_ = ref;
  }

 private:
  T ref_ = nullptr;
};

}  // namespace babelvoice
