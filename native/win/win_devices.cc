// clang-format off
#include <initguid.h>  // defines the PROPERTYKEYs below in this TU
#include "win_devices.h"
// clang-format on

#include <functiondiscoverykeys_devpkey.h>
#include <mmreg.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <mutex>

#include "../napi_util.h"

namespace babelvoice {

ComPtr<IMMDeviceEnumerator> CreateDeviceEnumerator() {
  ComPtr<IMMDeviceEnumerator> enumerator;
  CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator));
  return enumerator;
}

std::string EndpointName(IMMDevice *device) {
  if (!device) return {};
  ComPtr<IPropertyStore> store;
  if (FAILED(device->OpenPropertyStore(STGM_READ, &store))) return {};
  PROPVARIANT value;
  PropVariantInit(&value);
  std::string name;
  if (SUCCEEDED(store->GetValue(PKEY_Device_FriendlyName, &value)) && value.vt == VT_LPWSTR) {
    name = WideToUtf8(value.pwszVal);
  }
  PropVariantClear(&value);
  return name;
}

std::string EndpointId(IMMDevice *device) {
  if (!device) return {};
  LPWSTR id = nullptr;
  if (FAILED(device->GetId(&id)) || !id) return {};
  std::string out = WideToUtf8(id);
  CoTaskMemFree(id);
  return out;
}

namespace {

std::wstring EndpointWideId(IMMDevice *device) {
  LPWSTR id = nullptr;
  if (!device || FAILED(device->GetId(&id)) || !id) return {};
  std::wstring out(id);
  CoTaskMemFree(id);
  return out;
}

// The engine's shared-mode format, from the property store: cheaper than
// activating an IAudioClient per endpoint just to read GetMixFormat.
void ReadDeviceFormat(IMMDevice *device, EndpointInfo &info) {
  ComPtr<IPropertyStore> store;
  if (FAILED(device->OpenPropertyStore(STGM_READ, &store))) return;
  PROPVARIANT value;
  PropVariantInit(&value);
  if (SUCCEEDED(store->GetValue(PKEY_AudioEngine_DeviceFormat, &value)) && value.vt == VT_BLOB &&
      value.blob.cbSize >= sizeof(WAVEFORMATEX)) {
    const auto *format = reinterpret_cast<const WAVEFORMATEX *>(value.blob.pBlobData);
    info.sampleRate = format->nSamplesPerSec;
    info.channels = format->nChannels;
  }
  PropVariantClear(&value);
}

}  // namespace

std::vector<EndpointInfo> EnumerateEndpoints(EDataFlow flow) {
  std::vector<EndpointInfo> out;
  ComPtr<IMMDeviceEnumerator> enumerator = CreateDeviceEnumerator();
  if (!enumerator) return out;
  std::wstring defaultId;
  {
    ComPtr<IMMDevice> device;
    if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(flow, eConsole, &device))) {
      defaultId = EndpointWideId(device.Get());
    }
  }
  ComPtr<IMMDeviceCollection> collection;
  if (FAILED(enumerator->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, &collection))) return out;
  UINT count = 0;
  collection->GetCount(&count);
  for (UINT i = 0; i < count; i++) {
    ComPtr<IMMDevice> device;
    if (FAILED(collection->Item(i, &device))) continue;
    EndpointInfo info;
    info.id = EndpointWideId(device.Get());
    info.name = EndpointName(device.Get());
    info.render = flow == eRender;
    info.isDefault = !info.id.empty() && info.id == defaultId;
    ReadDeviceFormat(device.Get(), info);
    out.push_back(std::move(info));
  }
  return out;
}

ComPtr<IMMDevice> EndpointForId(const std::string &uid) {
  ComPtr<IMMDevice> device;
  ComPtr<IMMDeviceEnumerator> enumerator = CreateDeviceEnumerator();
  if (!enumerator || uid.empty()) return device;
  const std::wstring wide = Utf8ToWide(uid);
  if (FAILED(enumerator->GetDevice(wide.c_str(), &device))) return nullptr;
  DWORD state = 0;
  if (FAILED(device->GetState(&state)) || state != DEVICE_STATE_ACTIVE) return nullptr;
  return device;
}

ComPtr<IMMDevice> DefaultEndpoint(EDataFlow flow) {
  ComPtr<IMMDevice> device;
  ComPtr<IMMDeviceEnumerator> enumerator = CreateDeviceEnumerator();
  if (enumerator) enumerator->GetDefaultAudioEndpoint(flow, eConsole, &device);
  return device;
}

std::string FindVirtualOutputId(const std::string &pattern) {
  const std::vector<EndpointInfo> endpoints = EnumerateEndpoints(eRender);
  const auto rank = [](const std::string &name) {
    if (NameMatchesPattern(name, "babelvoice")) return 0;
    if (NameMatchesPattern(name, "cable input")) return 1;
    return 2;
  };
  const EndpointInfo *best = nullptr;
  for (const EndpointInfo &endpoint : endpoints) {
    if (!NameMatchesPattern(endpoint.name, pattern)) continue;
    if (!best || rank(endpoint.name) < rank(best->name)) best = &endpoint;
  }
  return best ? WideToUtf8(best->id.c_str()) : std::string();
}

// ---------------------------------------------------------------------------
// Topology notifications.
// ---------------------------------------------------------------------------

namespace {

std::atomic<uint64_t> gTopologyGeneration{1};
std::atomic<uint64_t> gDefaultCaptureGeneration{1};
std::atomic<uint64_t> gDefaultRenderGeneration{1};

class NotificationClient final : public IMMNotificationClient {
 public:
  ULONG STDMETHODCALLTYPE AddRef() override { return ++refs_; }
  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG refs = --refs_;
    if (refs == 0) delete this;
    return refs;
  }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **out) override {
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IMMNotificationClient)) {
      *out = static_cast<IMMNotificationClient *>(this);
      AddRef();
      return S_OK;
    }
    *out = nullptr;
    return E_NOINTERFACE;
  }
  HRESULT STDMETHODCALLTYPE OnDeviceStateChanged(LPCWSTR, DWORD) override { return Bump(); }
  HRESULT STDMETHODCALLTYPE OnDeviceAdded(LPCWSTR) override { return Bump(); }
  HRESULT STDMETHODCALLTYPE OnDeviceRemoved(LPCWSTR) override { return Bump(); }
  HRESULT STDMETHODCALLTYPE OnDefaultDeviceChanged(EDataFlow flow, ERole role, LPCWSTR) override {
    if (flow == eCapture && role == eConsole) gDefaultCaptureGeneration.fetch_add(1);
    if (flow == eRender && role == eConsole) gDefaultRenderGeneration.fetch_add(1);
    return Bump();
  }
  // Renames (e.g. in Sound settings) change what matches the pattern.
  HRESULT STDMETHODCALLTYPE OnPropertyValueChanged(LPCWSTR, const PROPERTYKEY key) override {
    if (IsEqualPropertyKey(key, PKEY_Device_FriendlyName)) Bump();
    return S_OK;
  }

 private:
  static HRESULT Bump() {
    gTopologyGeneration.fetch_add(1);
    return S_OK;
  }
  std::atomic<ULONG> refs_{1};
};

struct NotificationRegistration {
  std::mutex mutex;
  ComPtr<IMMDeviceEnumerator> enumerator;  // guarded by mutex
  NotificationClient *client = nullptr;    // guarded by mutex
};

NotificationRegistration &Registration() {
  static NotificationRegistration *const registration = new NotificationRegistration();
  return *registration;
}

// Backs the notifications up in case one is missed.
constexpr auto kVirtualOutputTtl = std::chrono::seconds(5);

}  // namespace

void EnsureDeviceNotifications() {
  NotificationRegistration &reg = Registration();
  std::lock_guard<std::mutex> lock(reg.mutex);
  if (reg.client) return;
  reg.enumerator = CreateDeviceEnumerator();
  if (!reg.enumerator) return;
  auto *client = new NotificationClient();
  if (FAILED(reg.enumerator->RegisterEndpointNotificationCallback(client))) {
    client->Release();
    reg.enumerator.Reset();
    return;
  }
  reg.client = client;
}

uint64_t DeviceTopologyGeneration() { return gTopologyGeneration.load(); }
uint64_t DefaultCaptureGeneration() { return gDefaultCaptureGeneration.load(); }
uint64_t DefaultRenderGeneration() { return gDefaultRenderGeneration.load(); }

bool HasVirtualOutputCached() {
  static uint64_t cachedGeneration = 0;
  static std::chrono::steady_clock::time_point cachedAt{};
  static bool cached = false;
  EnsureDeviceNotifications();
  const auto now = std::chrono::steady_clock::now();
  const uint64_t generation = DeviceTopologyGeneration();
  if (generation == cachedGeneration && now - cachedAt < kVirtualOutputTtl) return cached;
  cached = !FindVirtualOutputId(kDefaultVirtualPattern).empty();
  cachedGeneration = generation;
  cachedAt = now;
  return cached;
}

void ReleaseDeviceNotifications() {
  NotificationRegistration &reg = Registration();
  std::lock_guard<std::mutex> lock(reg.mutex);
  if (!reg.client) return;
  reg.enumerator->UnregisterEndpointNotificationCallback(reg.client);
  reg.client->Release();
  reg.client = nullptr;
  reg.enumerator.Reset();
}

namespace {

// CapabilityAccessManager consent value: false only for an explicit "Deny".
bool ConsentAllows(HKEY root, const wchar_t *subkey) {
  wchar_t value[32] = {};
  DWORD size = sizeof(value);
  if (RegGetValueW(root, subkey, L"Value", RRF_RT_REG_SZ, nullptr, value, &size) != ERROR_SUCCESS) {
    return true;  // never set: allowed by default
  }
  return _wcsicmp(value, L"Deny") != 0;
}

}  // namespace

const char *MicrophonePermissionStatus() {
  const wchar_t *store = L"Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";
  const wchar_t *desktop =
    L"Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged";
  // Device-wide switch (admin), the user's master switch, then "Let desktop
  // apps access your microphone".
  const bool allowed =
    ConsentAllows(HKEY_LOCAL_MACHINE, store) && ConsentAllows(HKEY_CURRENT_USER, store) &&
    ConsentAllows(HKEY_CURRENT_USER, desktop);
  return allowed ? "granted" : "denied";
}

napi_value ListAudioDevices(napi_env env, napi_callback_info info) {
  (void)info;
  ScopedCom com(COINIT_APARTMENTTHREADED);
  napi_value array;
  napi_create_array(env, &array);
  uint32_t index = 0;
  for (EDataFlow flow : {eCapture, eRender}) {
    for (const EndpointInfo &endpoint : EnumerateEndpoints(flow)) {
      napi_value obj;
      napi_create_object(env, &obj);
      SetNamed(env, obj, "id", MakeNumber(env, index + 1));
      SetNamed(env, obj, "uid", MakeString(env, WideToUtf8(endpoint.id.c_str()).c_str()));
      SetNamed(env, obj, "name", MakeString(env, endpoint.name.c_str()));
      SetNamed(env, obj, "kind", MakeString(env, endpoint.render ? "output" : "input"));
      SetNamed(env, obj, "isDefault", MakeBool(env, endpoint.isDefault));
      SetNamed(env, obj, "isVirtual", MakeBool(env, NameMatchesPattern(endpoint.name, kDefaultVirtualPattern)));
      SetNamed(env, obj, "isAlive", MakeBool(env, true));
      SetNamed(env, obj, "sampleRate", MakeNumber(env, endpoint.sampleRate));
      SetNamed(env, obj, "channels", MakeNumber(env, endpoint.channels));
      napi_set_element(env, array, index++, obj);
    }
  }
  return array;
}

}  // namespace babelvoice
