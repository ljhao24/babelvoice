#include "win_common.h"

#include <algorithm>
#include <cctype>
#include <cstdio>

namespace babelvoice {

std::string WideToUtf8(const wchar_t *wide) {
  if (!wide || !*wide) return {};
  const int len = WideCharToMultiByte(CP_UTF8, 0, wide, -1, nullptr, 0, nullptr, nullptr);
  if (len <= 1) return {};
  std::string out(static_cast<size_t>(len - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, wide, -1, out.data(), len, nullptr, nullptr);
  return out;
}

std::wstring Utf8ToWide(const std::string &utf8) {
  if (utf8.empty()) return {};
  const int len = MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, nullptr, 0);
  if (len <= 1) return {};
  std::wstring out(static_cast<size_t>(len - 1), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, out.data(), len);
  return out;
}

std::string HrMessage(const char *context, HRESULT hr) {
  char buf[256];
  std::snprintf(buf, sizeof(buf), "%s (0x%08lX)", context, static_cast<unsigned long>(hr));
  return buf;
}

namespace {

std::string AsciiLower(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
    return static_cast<char>(c < 0x80 ? std::tolower(c) : c);
  });
  return value;
}

}  // namespace

bool NameMatchesPattern(const std::string &name, const std::string &pattern) {
  if (name.empty() || pattern.empty()) return false;
  const std::string haystack = AsciiLower(name);
  size_t start = 0;
  while (start <= pattern.size()) {
    const size_t end = std::min(pattern.find('|', start), pattern.size());
    const std::string needle = AsciiLower(pattern.substr(start, end - start));
    if (!needle.empty() && haystack.find(needle) != std::string::npos) return true;
    start = end + 1;
  }
  return false;
}

DWORD WindowsBuildNumber() {
  static const DWORD build = [] {
    using RtlGetVersionFn = LONG(WINAPI *)(OSVERSIONINFOW *);
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    auto fn = ntdll ? reinterpret_cast<RtlGetVersionFn>(GetProcAddress(ntdll, "RtlGetVersion")) : nullptr;
    OSVERSIONINFOW info{};
    info.dwOSVersionInfoSize = sizeof(info);
    if (fn && fn(&info) == 0) return info.dwBuildNumber;
    return static_cast<DWORD>(0);
  }();
  return build;
}

}  // namespace babelvoice
