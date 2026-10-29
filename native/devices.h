// CoreAudio device queries, the virtual-loopback ("is this BabelVoice /
// BlackHole?") policy, property-listener RAII and the device-topology cache.
// Objective-C++ (ARC) only.
#pragma once

#include <node_api.h>

#import <CoreAudio/CoreAudio.h>
#import <Foundation/Foundation.h>

#include <chrono>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace babelvoice {

constexpr const char *kDefaultVirtualPattern = "babelvoice|blackhole";

// --- Device properties (any thread; HAL calls, so never on an IO thread). ---

bool IsVirtualName(NSString *name, const std::string &pattern);
bool DeviceHasOutput(AudioDeviceID device);
bool DeviceHasInput(AudioDeviceID device);
UInt32 DeviceChannelCount(AudioDeviceID device, AudioObjectPropertyScope scope);
Float64 DeviceSampleRate(AudioDeviceID device);
bool DeviceIsAlive(AudioDeviceID device);
UInt32 DeviceTransportType(AudioDeviceID device);
NSString *CopyStringProperty(AudioDeviceID device, AudioObjectPropertySelector selector);
AudioDeviceID DefaultDevice(AudioObjectPropertySelector selector);
AudioDeviceID DeviceForUID(const std::string &uid);

// Best non-aggregate output whose name matches `pattern`.
AudioDeviceID FindVirtualOutputDeviceID(const std::string &pattern);
// Alive, has output, name matches `pattern`, not an aggregate/multi-output.
bool IsSafeVirtualOutputDevice(AudioDeviceID device, const std::string &pattern);

// --- Property listeners. ---

// Serial queue for every CoreAudio listener block we install. Blocks never
// dispatch_sync back to the JS thread, so the JS thread may sync onto it.
dispatch_queue_t MonitorQueue();

// One installed CoreAudio property listener block; removed on destruction.
//
// Removal matches by block pointer. Callers pass stack literals, and storing
// one in a member copies it to the heap under ARC — Add then got the stack
// pointer and Remove the heap one, so the listener (and everything it
// captured) was never removed. The block is copied once and that pointer is
// used for both calls.
//
// Blocks already dispatched may still run after removal; they must only
// touch state they own (shared_ptr / weak_ptr captures), never raw globals of
// a torn-down capture.
class PropertyListener {
 public:
  // nullptr when the object is unknown or the HAL refused the listener.
  static std::unique_ptr<PropertyListener> Install(
    AudioObjectID object,
    AudioObjectPropertySelector selector,
    AudioObjectPropertyScope scope,
    AudioObjectPropertyListenerBlock block);
  ~PropertyListener();
  PropertyListener(const PropertyListener &) = delete;
  PropertyListener &operator=(const PropertyListener &) = delete;

 private:
  PropertyListener() = default;
  AudioObjectID object_ = kAudioObjectUnknown;
  AudioObjectPropertyAddress address_{};
  AudioObjectPropertyListenerBlock block_ = nil;
};

// Listeners that share a lifetime. Not thread-safe: each set is owned by one
// thread (the JS thread or TapQueue). Removal runs in installation order.
class ListenerSet {
 public:
  ListenerSet() = default;
  ~ListenerSet() { Clear(); }
  ListenerSet(const ListenerSet &) = delete;
  ListenerSet &operator=(const ListenerSet &) = delete;

  bool Add(
    AudioObjectID object,
    AudioObjectPropertySelector selector,
    AudioObjectPropertyScope scope,
    AudioObjectPropertyListenerBlock block);
  void Clear();
  bool empty() const { return listeners_.empty(); }

 private:
  std::vector<std::unique_ptr<PropertyListener>> listeners_;
};

// --- Device topology cache. ---
//
// Walking every HAL device (and allocating an NSString per name) on each TTS
// chunk or capability poll is wasteful. A listener on the device list (plus
// IsAlive on the bound TTS device) bumps a generation counter; cached answers
// stay valid until it moves. A short TTL backs the listener up in case a
// notification is missed (e.g. a device renamed in Audio MIDI Setup).

struct DeviceCheckStamp {
  uint64_t gen = 0;  // 0 = never fresh
  std::chrono::steady_clock::time_point at{};
};

// Any thread (listener blocks).
void BumpDeviceTopology();
// JS thread. Take the stamp *before* the expensive check so a change that
// races the check invalidates it. Never fresh when the device-list listener
// can't be installed.
DeviceCheckStamp CurrentDeviceStamp();
// JS thread.
bool DeviceStampFresh(const DeviceCheckStamp &stamp);
// JS thread. Cached "is a BabelVoice/BlackHole output present?".
bool HasVirtualOutputCached();
// JS thread, env teardown.
void ReleaseDeviceTopologyListeners();

// listAudioDevices() -> NativeAudioDevice[]
napi_value ListAudioDevices(napi_env env, napi_callback_info info);

}  // namespace babelvoice
