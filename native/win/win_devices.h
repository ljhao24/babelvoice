// MMDevice endpoint queries, the virtual-loopback ("is this VB-Cable /
// BabelVoice?") policy and the device-topology generation counters.
// Windows counterpart of devices.h.
#pragma once

#include <node_api.h>

#include "win_common.h"

#include <mmdeviceapi.h>

#include <cstdint>
#include <string>
#include <vector>

namespace babelvoice {

// Names that count as the virtual loopback: VB-Cable's render side is
// "CABLE Input (VB-Audio Virtual Cable)", its capture side "CABLE Output
// (VB-Audio Virtual Cable)" — the one meeting apps pick as their mic, and
// the one we must never record (it would loop our own TTS back in).
constexpr const char *kDefaultVirtualPattern = "babelvoice|vb-audio|cable input|cable output";

struct EndpointInfo {
  std::wstring id;   // IMMDevice::GetId — stable across reboots; the "uid"
  std::string name;  // PKEY_Device_FriendlyName, UTF-8
  bool render = false;
  bool isDefault = false;
  double sampleRate = 0;
  uint32_t channels = 0;
};

// Any thread with COM initialized.
ComPtr<IMMDeviceEnumerator> CreateDeviceEnumerator();
std::vector<EndpointInfo> EnumerateEndpoints(EDataFlow flow);
ComPtr<IMMDevice> EndpointForId(const std::string &uid);
ComPtr<IMMDevice> DefaultEndpoint(EDataFlow flow);
std::string EndpointName(IMMDevice *device);
std::string EndpointId(IMMDevice *device);

// Best active render endpoint whose name matches `pattern` (BabelVoice
// first, then VB-Cable's "CABLE Input", then anything else that matches);
// empty when none.
std::string FindVirtualOutputId(const std::string &pattern);

// --- Topology notifications. ---
//
// One IMMNotificationClient, registered on first use. Callbacks only bump
// counters; consumers (TTS prepare, the mic thread) compare generations
// rather than being called back, so nothing runs on the notification thread.
void EnsureDeviceNotifications();
// Any device added / removed / state change / default change.
uint64_t DeviceTopologyGeneration();
// The default capture endpoint changed (an unpinned mic follows it).
uint64_t DefaultCaptureGeneration();
// The default render endpoint changed (system-audio loopback follows it).
uint64_t DefaultRenderGeneration();
// JS thread. Cached "is a VB-Cable / BabelVoice render endpoint present?".
bool HasVirtualOutputCached();
// JS thread, env teardown.
void ReleaseDeviceNotifications();

// Settings → Privacy & security → Microphone, as it applies to desktop
// apps: "granted" or "denied". With access off, WASAPI still "captures" —
// pure silence — so a session would look healthy while sending nothing.
const char *MicrophonePermissionStatus();

// listAudioDevices() -> NativeAudioDevice[]
napi_value ListAudioDevices(napi_env env, napi_callback_info info);

}  // namespace babelvoice
