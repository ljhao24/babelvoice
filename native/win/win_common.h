// Windows-only helpers shared by the WASAPI subsystems: COM apartment
// scoping, UTF-8 <-> UTF-16 conversion, HRESULT formatting.
#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <wrl/client.h>

#include <string>

namespace babelvoice {

using Microsoft::WRL::ComPtr;

// Initializes COM on the calling thread for its lifetime. A thread whose
// apartment is already set (Electron's main thread is STA) keeps it; we only
// balance what we added.
class ScopedCom {
 public:
  explicit ScopedCom(DWORD model = COINIT_MULTITHREADED) {
    const HRESULT hr = CoInitializeEx(nullptr, model);
    initialized_ = SUCCEEDED(hr);  // S_OK or S_FALSE; RPC_E_CHANGED_MODE: leave it
  }
  ~ScopedCom() {
    if (initialized_) CoUninitialize();
  }
  ScopedCom(const ScopedCom &) = delete;
  ScopedCom &operator=(const ScopedCom &) = delete;

 private:
  bool initialized_ = false;
};

std::string WideToUtf8(const wchar_t *wide);
std::wstring Utf8ToWide(const std::string &utf8);

// "context (0x88890004)".
std::string HrMessage(const char *context, HRESULT hr);

// Case-insensitive: does `name` contain any '|'-separated alternative of
// `pattern`? Mirrors the macOS IsVirtualName regex for the simple
// alternations the app passes ("babelvoice|cable input|vb-audio").
bool NameMatchesPattern(const std::string &name, const std::string &pattern);

// Windows build number (e.g. 22631), from RtlGetVersion: GetVersionEx lies
// to unmanifested processes.
DWORD WindowsBuildNumber();

}  // namespace babelvoice
