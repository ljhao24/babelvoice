// System audio and per-app audio capture. Implements sck_capture.h and
// process_tap.h for Windows:
//   - system audio: loopback on the default output device, following it
//     when the default changes. Our TTS renders into VB-Cable, a different
//     endpoint, so it is never captured — the same effect as macOS's
//     excludesCurrentProcessAudio (which excludes only the main process,
//     where the TTS unit lives). The renderer's own playback (onboarding
//     sample, TTS monitor) is still heard, as on macOS.
//   - per-app audio: process loopback that INCLUDES one app's process tree
//     (Zoom, Teams, Tencent Meeting...). The app is identified by its
//     lower-cased executable name, which stands in for the macOS bundle id.
//
// Loopback streams deliver nothing while the source is silent. Translation
// engines need that silence (server-side VAD finalizes a sentence on it), so
// the worker pads gaps with zeros to keep the stream at real-time pace.
#include "../process_tap.h"
#include "../sck_capture.h"

#include "win_common.h"  // windows.h, ahead of the SDK headers below

#include <audiopolicy.h>
#include <tlhelp32.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <memory>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "../capture_sink.h"
#include "../diagnostics.h"
#include "../napi_util.h"
#include "../promise_settler.h"
#include "win_capture_stream.h"
#include "win_common.h"
#include "win_devices.h"

namespace babelvoice {

namespace {

// Chunks handed to JS: ~40 ms, like the macOS captures.
constexpr double kChunkSeconds = 0.040;
// Pad silence once the source has been quiet this long.
constexpr double kSilenceGapSeconds = 0.100;

enum class LoopbackKind { System, Process };

struct LoopbackRun {
  LoopbackKind kind = LoopbackKind::System;
  DWORD pid = 0;
  double sampleRate = kDefaultCaptureSampleRate;
  std::shared_ptr<CaptureSink> sink;
  std::thread thread;
  HANDLE stopEvent = nullptr;

  ~LoopbackRun() {
    if (stopEvent) CloseHandle(stopEvent);
  }
};

// JS thread only.
std::unique_ptr<LoopbackRun> gSystemRun;
std::unique_ptr<LoopbackRun> gProcessRun;

std::unique_ptr<LoopbackRun> &Slot(LoopbackKind kind) {
  return kind == LoopbackKind::System ? gSystemRun : gProcessRun;
}

NativeDiagnostics &Diag() { return ListenDiagnostics(); }

std::unique_ptr<CaptureStream> OpenStream(const LoopbackRun &run, std::string &error) {
  if (run.kind == LoopbackKind::Process) {
    return CaptureStream::OpenProcessLoopback(run.pid, true, run.sampleRate, error);
  }
  ComPtr<IMMDevice> device = DefaultEndpoint(eRender);
  if (device && NameMatchesPattern(EndpointName(device.Get()), kDefaultVirtualPattern)) {
    error = "系统默认输出设备是虚拟声卡，无法采集会议声音。请在 Windows 声音设置中把输出设为耳机或扬声器。";
    return nullptr;
  }
  return CaptureStream::OpenEndpoint(device.Get(), true, run.sampleRate, error);
}

void CaptureLoop(LoopbackRun *run, std::shared_ptr<PromiseSettler> settler) {
  ScopedCom com;
  std::string error;
  std::unique_ptr<CaptureStream> stream = OpenStream(*run, error);
  if (stream && !stream->Start(error)) stream.reset();
  if (!stream) {
    SetLastError(Diag(), error.c_str());
    Settle(settler, false, error);
    return;
  }
  const char *route = run->kind == LoopbackKind::System ? "system-audio" : "process-audio";
  SetRouteStatus(Diag(), route);
  Settle(settler, true, {});

  using Clock = std::chrono::steady_clock;
  const double rate = run->sampleRate;
  const size_t chunkSamples = static_cast<size_t>(rate * kChunkSeconds);
  const auto start = Clock::now();
  uint64_t emitted = 0;  // samples handed on, real or padded
  std::vector<int16_t> pending;
  pending.reserve(chunkSamples * 4);

  const auto flush = [&](bool force) {
    while (pending.size() >= chunkSamples || (force && !pending.empty())) {
      const size_t take = std::min(pending.size(), chunkSamples);
      UpdateDiagnostics(Diag(), pending.data(), take * sizeof(int16_t), route);
      run->sink->PostPcm(CopyPacket(pending.data(), take * sizeof(int16_t)));
      pending.erase(pending.begin(), pending.begin() + static_cast<std::ptrdiff_t>(take));
    }
  };

  const bool system = run->kind == LoopbackKind::System;
  uint64_t defaultGeneration = DefaultRenderGeneration();
  // Loopback is bound to the output that was default when it opened; follow
  // the new one (the gap is padded with silence like any other).
  const auto reopen = [&]() -> bool {
    defaultGeneration = DefaultRenderGeneration();
    stream.reset();
    stream = OpenStream(*run, error);
    return stream && stream->Start(error);
  };

  for (;;) {
    const HANDLE waits[2] = {run->stopEvent, stream->event()};
    if (WaitForMultipleObjects(2, waits, FALSE, 20) == WAIT_OBJECT_0) return;
    HRESULT hr = S_OK;
    if (system && DefaultRenderGeneration() != defaultGeneration) {
      if (!reopen()) hr = AUDCLNT_E_DEVICE_INVALIDATED;
    } else {
      const size_t before = pending.size();
      hr = stream->Read(pending);
      emitted += pending.size() - before;
      if (hr == AUDCLNT_E_DEVICE_INVALIDATED && system && reopen()) continue;
    }
    if (FAILED(hr)) {
      const std::string message = !system ? "会议软件的音频采集意外停止（应用可能已退出）"
                                  : error.empty() ? "系统音频采集意外停止（输出设备可能已断开）"
                                                  : "系统音频采集意外停止：" + error;
      SetLastError(Diag(), message.c_str());
      run->sink->Fail(message.c_str(), [] {});
      SetRouteStatus(Diag(), "failed");
      return;
    }
    // Keep real-time pace through silence.
    const double elapsed = std::chrono::duration<double>(Clock::now() - start).count();
    const double expected = elapsed * rate;
    if (expected - static_cast<double>(emitted) > rate * kSilenceGapSeconds) {
      const size_t pad = static_cast<size_t>(expected - static_cast<double>(emitted) - rate * 0.020);
      pending.insert(pending.end(), pad, 0);
      emitted += pad;
    }
    flush(false);
  }
}

// JS thread. Stops the worker; afterwards nothing reaches JS from this run.
void StopRun(LoopbackKind kind, bool releaseJs) {
  std::unique_ptr<LoopbackRun> run = std::move(Slot(kind));
  if (!run) return;
  run->sink->BeginStop();
  if (run->thread.joinable()) {
    SetEvent(run->stopEvent);
    run->thread.join();
  }
  if (releaseJs) {
    run->sink->Release();
  } else {
    run->sink->Detach();
  }
  SetRouteStatus(Diag(), "idle");
}

void StopSystemIfCurrent(CaptureSink *sink) {
  if (gSystemRun && gSystemRun->sink.get() == sink) StopRun(LoopbackKind::System, false);
}

void StopProcessIfCurrent(CaptureSink *sink) {
  if (gProcessRun && gProcessRun->sink.get() == sink) StopRun(LoopbackKind::Process, false);
}

napi_value ResolvedPromise(napi_env env) {
  napi_deferred deferred;
  napi_value promise;
  napi_create_promise(env, &deferred, &promise);
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  napi_resolve_deferred(env, deferred, undefined);
  return promise;
}

napi_value StartLoopback(
  napi_env env, LoopbackKind kind, DWORD pid, napi_value onPcm, napi_value onError, double sampleRate) {
  // One capture per kind: a second start replaces the first.
  StopRun(kind, true);
  EnsureDeviceNotifications();

  auto run = std::make_unique<LoopbackRun>();
  run->kind = kind;
  run->pid = pid;
  run->sampleRate = sampleRate;
  run->stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  const bool system = kind == LoopbackKind::System;
  run->sink = CreateCaptureSink(env, onPcm, onError,
                                system ? "BabelVoiceSystemAudioCapture" : "BabelVoiceProcessAudioCapture",
                                system ? StopSystemIfCurrent : StopProcessIfCurrent);
  if (!run->sink || !run->stopEvent) {
    if (run->sink) run->sink->Release();
    Throw(env, "failed to create audio capture callbacks");
    return nullptr;
  }
  napi_value promise;
  std::shared_ptr<PromiseSettler> settler = CreateSettler(env, "BabelVoiceLoopbackStart", &promise);
  if (!settler) {
    run->sink->Release();
    Throw(env, "failed to create audio capture promise");
    return nullptr;
  }
  CaptureSink *sink = run->sink.get();
  // A failed start leaves nothing behind (JS thread, right before reject).
  settler->onSettledJs = [kind, sink](bool ok) {
    if (!ok && Slot(kind) && Slot(kind)->sink.get() == sink) StopRun(kind, true);
  };
  LoopbackRun *raw = run.get();
  Slot(kind) = std::move(run);
  raw->thread = std::thread(CaptureLoop, raw, settler);
  return promise;
}

// ---------------------------------------------------------------------------
// Applications with audio, for the 收听来源 picker.
// ---------------------------------------------------------------------------

struct ProcessEntry {
  DWORD parent = 0;
  std::wstring exe;  // lower-cased file name
};

std::wstring Lower(std::wstring value) {
  std::transform(value.begin(), value.end(), value.begin(), [](wchar_t c) { return towlower(c); });
  return value;
}

std::unordered_map<DWORD, ProcessEntry> SnapshotProcesses() {
  std::unordered_map<DWORD, ProcessEntry> out;
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return out;
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  for (BOOL ok = Process32FirstW(snapshot, &entry); ok; ok = Process32NextW(snapshot, &entry)) {
    out[entry.th32ProcessID] = ProcessEntry{entry.th32ParentProcessID, Lower(entry.szExeFile)};
  }
  CloseHandle(snapshot);
  return out;
}

// Parents an app's audio helper must not be attributed to: the shell,
// service hosts and terminals launch apps rather than being them.
bool IsLauncher(const std::wstring &exe) {
  static const std::unordered_set<std::wstring> launchers = {
    L"explorer.exe", L"svchost.exe", L"services.exe", L"wininit.exe", L"winlogon.exe",
    L"sihost.exe", L"runtimebroker.exe", L"userinit.exe", L"cmd.exe", L"powershell.exe",
    L"pwsh.exe", L"windowsterminal.exe", L"conhost.exe", L"openconsole.exe", L"smss.exe",
    L"csrss.exe", L"system", L"[system process]"};
  return launchers.count(exe) > 0;
}

// The top of `pid`'s app tree: Chrome's audio utility process -> chrome.exe,
// Teams' WebView2 -> ms-teams.exe.
DWORD AppRoot(DWORD pid, const std::unordered_map<DWORD, ProcessEntry> &processes) {
  DWORD current = pid;
  for (int depth = 0; depth < 16; depth++) {
    const auto self = processes.find(current);
    if (self == processes.end()) break;
    const auto parent = processes.find(self->second.parent);
    if (parent == processes.end() || parent->first == current || parent->first <= 4) break;
    if (IsLauncher(parent->second.exe)) break;
    current = parent->first;
  }
  return current;
}

std::wstring ProcessImagePath(DWORD pid) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return {};
  wchar_t path[MAX_PATH * 2];
  DWORD size = static_cast<DWORD>(std::size(path));
  std::wstring out;
  if (QueryFullProcessImageNameW(process, 0, path, &size)) out.assign(path, size);
  CloseHandle(process);
  return out;
}

// FileDescription from the version resource ("Zoom Meetings", "腾讯会议"),
// else the executable name without ".exe".
std::string DisplayName(DWORD pid, const std::wstring &exe) {
  const std::wstring path = ProcessImagePath(pid);
  if (!path.empty()) {
    DWORD handle = 0;
    const DWORD size = GetFileVersionInfoSizeW(path.c_str(), &handle);
    if (size > 0) {
      std::vector<BYTE> data(size);
      if (GetFileVersionInfoW(path.c_str(), 0, size, data.data())) {
        struct Translation {
          WORD language;
          WORD codepage;
        } *translations = nullptr;
        UINT length = 0;
        if (VerQueryValueW(data.data(), L"\\VarFileInfo\\Translation", reinterpret_cast<void **>(&translations), &length) &&
            length >= sizeof(Translation)) {
          wchar_t key[64];
          swprintf_s(key, L"\\StringFileInfo\\%04x%04x\\FileDescription", translations[0].language,
                     translations[0].codepage);
          wchar_t *description = nullptr;
          UINT descriptionLength = 0;
          if (VerQueryValueW(data.data(), key, reinterpret_cast<void **>(&description), &descriptionLength) &&
              descriptionLength > 1 && description && *description) {
            return WideToUtf8(description);
          }
        }
      }
    }
  }
  std::wstring name = exe;
  if (name.size() > 4 && name.compare(name.size() - 4, 4, L".exe") == 0) name.resize(name.size() - 4);
  return WideToUtf8(name.c_str());
}

// The running instance of the app whose executable is `bundleId`: the
// top-most process of that name (its parent is something else).
DWORD FindAppProcess(const std::string &bundleId) {
  const std::wstring exe = Lower(Utf8ToWide(bundleId));
  const std::unordered_map<DWORD, ProcessEntry> processes = SnapshotProcesses();
  DWORD fallback = 0;
  for (const auto &[pid, entry] : processes) {
    if (entry.exe != exe) continue;
    const auto parent = processes.find(entry.parent);
    if (parent == processes.end() || parent->second.exe != exe) return pid;
    if (!fallback) fallback = pid;
  }
  return fallback;
}

}  // namespace

napi_value StartSystemAudioCapture(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  napi_value onPcm = OptionalFunctionArg(env, args, argc, 0);
  if (!onPcm) {
    Throw(env, "startSystemAudioCapture requires a callback");
    return nullptr;
  }
  napi_value onError = OptionalFunctionArg(env, args, argc, 1);
  double sampleRate = kDefaultCaptureSampleRate;
  if (!CaptureSampleRateArg(env, args, argc, 2, sampleRate)) return nullptr;
  return StartLoopback(env, LoopbackKind::System, 0, onPcm, onError, sampleRate);
}

napi_value StopSystemAudioCapture(napi_env env, napi_callback_info info) {
  (void)info;
  StopRun(LoopbackKind::System, true);
  return ResolvedPromise(env);
}

void StopSystemAudioForTeardown() {
  StopRun(LoopbackKind::System, false);
}

napi_value ListAudioCapableApplications(napi_env env, napi_callback_info info) {
  (void)info;
  ScopedCom com(COINIT_APARTMENTTHREADED);
  const std::unordered_map<DWORD, ProcessEntry> processes = SnapshotProcesses();
  const DWORD self = GetCurrentProcessId();
  std::unordered_map<std::wstring, DWORD> apps;  // exe -> root pid
  std::vector<std::wstring> order;

  ComPtr<IMMDeviceEnumerator> enumerator = CreateDeviceEnumerator();
  ComPtr<IMMDeviceCollection> collection;
  if (enumerator && SUCCEEDED(enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &collection))) {
    UINT count = 0;
    collection->GetCount(&count);
    for (UINT i = 0; i < count; i++) {
      ComPtr<IMMDevice> device;
      ComPtr<IAudioSessionManager2> manager;
      ComPtr<IAudioSessionEnumerator> sessions;
      if (FAILED(collection->Item(i, &device)) ||
          FAILED(device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, &manager)) ||
          FAILED(manager->GetSessionEnumerator(&sessions))) {
        continue;
      }
      int sessionCount = 0;
      sessions->GetCount(&sessionCount);
      for (int s = 0; s < sessionCount; s++) {
        ComPtr<IAudioSessionControl> control;
        ComPtr<IAudioSessionControl2> control2;
        if (FAILED(sessions->GetSession(s, &control)) || FAILED(control.As(&control2))) continue;
        if (control2->IsSystemSoundsSession() == S_OK) continue;
        DWORD pid = 0;
        if (FAILED(control2->GetProcessId(&pid)) || pid == 0) continue;
        if (processes.find(pid) == processes.end()) continue;  // exited
        const DWORD root = AppRoot(pid, processes);
        if (root == self || AppRoot(self, processes) == root) continue;
        const std::wstring &exe = processes.at(root).exe;
        if (apps.emplace(exe, root).second) order.push_back(exe);
      }
    }
  }

  napi_value array;
  napi_create_array(env, &array);
  uint32_t index = 0;
  for (const std::wstring &exe : order) {
    const DWORD pid = apps[exe];
    napi_value obj;
    napi_create_object(env, &obj);
    SetNamed(env, obj, "pid", MakeNumber(env, pid));
    SetNamed(env, obj, "bundleId", MakeString(env, WideToUtf8(exe.c_str()).c_str()));
    SetNamed(env, obj, "name", MakeString(env, DisplayName(pid, exe).c_str()));
    napi_set_element(env, array, index++, obj);
  }
  return array;
}

napi_value StartProcessAudioCapture(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value args[4];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  napi_valuetype type = napi_undefined;
  if (argc >= 1) napi_typeof(env, args[0], &type);
  if (type != napi_string) {
    Throw(env, "startProcessAudioCapture requires an application id");
    return nullptr;
  }
  const std::string bundleId = StringArg(env, args[0]);
  napi_value onPcm = OptionalFunctionArg(env, args, argc, 1);
  if (!onPcm) {
    Throw(env, "startProcessAudioCapture requires a callback");
    return nullptr;
  }
  napi_value onError = OptionalFunctionArg(env, args, argc, 2);
  double sampleRate = kDefaultCaptureSampleRate;
  if (!CaptureSampleRateArg(env, args, argc, 3, sampleRate)) return nullptr;
  const DWORD pid = FindAppProcess(bundleId);
  if (!pid) {
    const std::string message = "没有找到正在运行的「" + bundleId + "」，请先打开会议软件再开始。";
    SetLastError(Diag(), message.c_str());
    Throw(env, message.c_str());
    return nullptr;
  }
  return StartLoopback(env, LoopbackKind::Process, pid, onPcm, onError, sampleRate);
}

napi_value StopProcessAudioCapture(napi_env env, napi_callback_info info) {
  (void)info;
  StopRun(LoopbackKind::Process, true);
  return ResolvedPromise(env);
}

void StopProcessTapForTeardown() {
  StopRun(LoopbackKind::Process, false);
}

}  // namespace babelvoice
