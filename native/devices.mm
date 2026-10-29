#include "devices.h"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cstring>

#include "napi_util.h"
#include "scoped_cf.h"

namespace babelvoice {

bool IsVirtualName(NSString *name, const std::string &pattern) {
  if (!name) return false;
  NSString *lower = [name lowercaseString];
  std::string lowerPattern = pattern;
  std::transform(lowerPattern.begin(), lowerPattern.end(), lowerPattern.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  const bool allowBabelVoice = pattern.empty() || lowerPattern.find("babelvoice") != std::string::npos;
  const bool allowBlackHole = pattern.empty() || lowerPattern.find("blackhole") != std::string::npos;
  return (allowBabelVoice && [lower containsString:@"babelvoice"]) ||
         (allowBlackHole && [lower containsString:@"blackhole"]);
}

namespace {

bool DeviceHasStreams(AudioDeviceID device, AudioObjectPropertyScope scope) {
  AudioObjectPropertyAddress address = {
    kAudioDevicePropertyStreams,
    scope,
    kAudioObjectPropertyElementMain
  };
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(device, &address, 0, nullptr, &size) != noErr) {
    return false;
  }
  return size > 0;
}

bool IsAggregateLikeOutput(AudioDeviceID device, NSString *name) {
  if (DeviceTransportType(device) == kAudioDeviceTransportTypeAggregate) {
    return true;
  }
  if (!name) return false;
  NSString *lower = [name lowercaseString];
  return [lower containsString:@"aggregate"] ||
         [lower containsString:@"multi-output"] ||
         [lower containsString:@"multi output"] ||
         [lower containsString:@"多输出"] ||
         [lower containsString:@"聚集"];
}

int VirtualOutputPriority(AudioDeviceID device, NSString *name) {
  if (!name) return 0;
  NSString *lower = [name lowercaseString];
  int score = 10;
  if (DeviceTransportType(device) != kAudioDeviceTransportTypeAggregate) score += 20;
  if ([lower isEqualToString:@"babelvoice"]) score += 100;
  else if ([lower hasPrefix:@"babelvoice"]) score += 80;
  else if ([lower hasPrefix:@"blackhole"]) score += 60;
  else if ([lower containsString:@"babelvoice"]) score += 40;
  else if ([lower containsString:@"blackhole"]) score += 30;
  return score;
}

std::vector<AudioDeviceID> AllDevices() {
  AudioObjectPropertyAddress address = {
    kAudioHardwarePropertyDevices,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain
  };
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, nullptr, &size) != noErr) {
    return {};
  }
  std::vector<AudioDeviceID> devices(size / sizeof(AudioDeviceID));
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, nullptr, &size, devices.data()) != noErr) {
    return {};
  }
  return devices;
}

// Capabilities reporting asks "is the device present?" via the UID lookup.
NSString *FindVirtualOutputDeviceUID(const std::string &pattern) {
  AudioDeviceID device = FindVirtualOutputDeviceID(pattern);
  if (device == kAudioObjectUnknown) return nil;
  return CopyStringProperty(device, kAudioDevicePropertyDeviceUID);
}

}  // namespace

bool DeviceHasOutput(AudioDeviceID device) {
  return DeviceHasStreams(device, kAudioDevicePropertyScopeOutput);
}

bool DeviceHasInput(AudioDeviceID device) {
  return DeviceHasStreams(device, kAudioDevicePropertyScopeInput);
}

UInt32 DeviceChannelCount(AudioDeviceID device, AudioObjectPropertyScope scope) {
  AudioObjectPropertyAddress address = {
    kAudioDevicePropertyStreamConfiguration,
    scope,
    kAudioObjectPropertyElementMain
  };
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(device, &address, 0, nullptr, &size) != noErr || size == 0) {
    return 0;
  }
  std::vector<uint8_t> storage(size);
  AudioBufferList *list = reinterpret_cast<AudioBufferList *>(storage.data());
  if (AudioObjectGetPropertyData(device, &address, 0, nullptr, &size, list) != noErr) {
    return 0;
  }
  UInt32 channels = 0;
  for (UInt32 i = 0; i < list->mNumberBuffers; i++) {
    channels += list->mBuffers[i].mNumberChannels;
  }
  return channels;
}

Float64 DeviceSampleRate(AudioDeviceID device) {
  AudioObjectPropertyAddress address = {
    kAudioDevicePropertyNominalSampleRate,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain
  };
  Float64 rate = 0;
  UInt32 size = sizeof(rate);
  if (AudioObjectGetPropertyData(device, &address, 0, nullptr, &size, &rate) != noErr) {
    return 0;
  }
  return rate;
}

bool DeviceIsAlive(AudioDeviceID device) {
  AudioObjectPropertyAddress address = {
    kAudioDevicePropertyDeviceIsAlive,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain
  };
  UInt32 alive = 0;
  UInt32 size = sizeof(alive);
  if (AudioObjectGetPropertyData(device, &address, 0, nullptr, &size, &alive) != noErr) {
    return false;
  }
  return alive != 0;
}

UInt32 DeviceTransportType(AudioDeviceID device) {
  AudioObjectPropertyAddress address = {
    kAudioDevicePropertyTransportType,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain
  };
  UInt32 transport = 0;
  UInt32 size = sizeof(transport);
  if (AudioObjectGetPropertyData(device, &address, 0, nullptr, &size, &transport) != noErr) {
    return 0;
  }
  return transport;
}

NSString *CopyStringProperty(AudioDeviceID device, AudioObjectPropertySelector selector) {
  AudioObjectPropertyAddress address = {
    selector,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain
  };
  CFStringRef value = nullptr;
  UInt32 size = sizeof(value);
  if (AudioObjectGetPropertyData(device, &address, 0, nullptr, &size, &value) != noErr || !value) {
    return nil;
  }
  return CFBridgingRelease(value);
}

AudioDeviceID DefaultDevice(AudioObjectPropertySelector selector) {
  AudioObjectPropertyAddress address = {
    selector,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain
  };
  AudioDeviceID device = kAudioObjectUnknown;
  UInt32 size = sizeof(device);
  AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, nullptr, &size, &device);
  return device;
}

AudioDeviceID DeviceForUID(const std::string &uid) {
  if (uid.empty()) return kAudioObjectUnknown;
  ScopedCFRef<CFStringRef> uidRef(CFStringCreateWithCString(nullptr, uid.c_str(), kCFStringEncodingUTF8));
  if (!uidRef) return kAudioObjectUnknown;
  CFStringRef uidValue = uidRef.get();
  AudioObjectPropertyAddress address = {
    kAudioHardwarePropertyTranslateUIDToDevice,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain
  };
  AudioDeviceID device = kAudioObjectUnknown;
  UInt32 size = sizeof(device);
  OSStatus status = AudioObjectGetPropertyData(
    kAudioObjectSystemObject, &address, sizeof(uidValue), &uidValue, &size, &device);
  return status == noErr ? device : kAudioObjectUnknown;
}

AudioDeviceID FindVirtualOutputDeviceID(const std::string &pattern) {
  AudioDeviceID best = kAudioObjectUnknown;
  int bestScore = -1;
  for (AudioDeviceID device : AllDevices()) {
    if (!DeviceHasOutput(device)) continue;
    NSString *name = CopyStringProperty(device, kAudioObjectPropertyName);
    if (!IsVirtualName(name, pattern)) continue;
    if (IsAggregateLikeOutput(device, name)) continue;
    const int score = VirtualOutputPriority(device, name);
    if (score > bestScore) {
      best = device;
      bestScore = score;
    }
  }
  return best;
}

bool IsSafeVirtualOutputDevice(AudioDeviceID device, const std::string &pattern) {
  if (device == kAudioObjectUnknown) return false;
  if (!DeviceIsAlive(device) || !DeviceHasOutput(device)) return false;
  NSString *name = CopyStringProperty(device, kAudioObjectPropertyName);
  if (!IsVirtualName(name, pattern)) return false;
  if (IsAggregateLikeOutput(device, name)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Property listeners.
// ---------------------------------------------------------------------------

dispatch_queue_t MonitorQueue() {
  static dispatch_queue_t queue = dispatch_queue_create("com.babelvoice.audio-monitor", DISPATCH_QUEUE_SERIAL);
  return queue;
}

std::unique_ptr<PropertyListener> PropertyListener::Install(
  AudioObjectID object,
  AudioObjectPropertySelector selector,
  AudioObjectPropertyScope scope,
  AudioObjectPropertyListenerBlock block
) {
  if (object == kAudioObjectUnknown) return nullptr;
  std::unique_ptr<PropertyListener> listener(new PropertyListener());
  listener->object_ = object;
  listener->address_ = { selector, scope, kAudioObjectPropertyElementMain };
  // The one heap copy both Add and Remove see (see the class comment).
  listener->block_ = [block copy];
  if (AudioObjectAddPropertyListenerBlock(object, &listener->address_, MonitorQueue(), listener->block_) != noErr) {
    listener->block_ = nil;  // nothing to remove
    return nullptr;
  }
  return listener;
}

PropertyListener::~PropertyListener() {
  if (!block_) return;
  AudioObjectRemovePropertyListenerBlock(object_, &address_, MonitorQueue(), block_);
}

bool ListenerSet::Add(
  AudioObjectID object,
  AudioObjectPropertySelector selector,
  AudioObjectPropertyScope scope,
  AudioObjectPropertyListenerBlock block
) {
  std::unique_ptr<PropertyListener> listener = PropertyListener::Install(object, selector, scope, block);
  if (!listener) return false;
  listeners_.push_back(std::move(listener));
  return true;
}

void ListenerSet::Clear() {
  // In installation order, like the hand-written loop this replaced.
  for (std::unique_ptr<PropertyListener> &listener : listeners_) listener.reset();
  listeners_.clear();
}

// ---------------------------------------------------------------------------
// Device topology cache.
// ---------------------------------------------------------------------------

namespace {

constexpr auto kDeviceCacheTtl = std::chrono::seconds(5);

struct VirtualOutputPresence {
  DeviceCheckStamp stamp;
  bool present = false;
};

struct DeviceTopology {
  std::atomic<uint64_t> gen{1};  // any thread
  ListenerSet deviceListListeners;  // JS thread only
  VirtualOutputPresence virtualOutput;  // JS thread only
};

DeviceTopology &Topology() {
  static DeviceTopology *const topology = new DeviceTopology();
  return *topology;
}

// JS thread. False when the listener can't be installed — cached device
// answers are then never trusted.
bool EnsureDeviceListListener() {
  DeviceTopology &topology = Topology();
  if (!topology.deviceListListeners.empty()) return true;
  return topology.deviceListListeners.Add(
    kAudioObjectSystemObject,
    kAudioHardwarePropertyDevices,
    kAudioObjectPropertyScopeGlobal,
    ^(UInt32, const AudioObjectPropertyAddress *) { BumpDeviceTopology(); });
}

}  // namespace

void BumpDeviceTopology() {
  Topology().gen.fetch_add(1, std::memory_order_acq_rel);
}

DeviceCheckStamp CurrentDeviceStamp() {
  if (!EnsureDeviceListListener()) return {};
  return { Topology().gen.load(std::memory_order_acquire), std::chrono::steady_clock::now() };
}

bool DeviceStampFresh(const DeviceCheckStamp &stamp) {
  return stamp.gen != 0 &&
         stamp.gen == Topology().gen.load(std::memory_order_acquire) &&
         std::chrono::steady_clock::now() - stamp.at < kDeviceCacheTtl;
}

bool HasVirtualOutputCached() {
  VirtualOutputPresence &presence = Topology().virtualOutput;
  if (DeviceStampFresh(presence.stamp)) return presence.present;
  const DeviceCheckStamp stamp = CurrentDeviceStamp();
  presence.present = FindVirtualOutputDeviceUID(kDefaultVirtualPattern) != nil;
  presence.stamp = stamp;
  return presence.present;
}

void ReleaseDeviceTopologyListeners() {
  Topology().deviceListListeners.Clear();
}

napi_value ListAudioDevices(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value array;
  napi_create_array(env, &array);
  const std::vector<AudioDeviceID> devices = AllDevices();
  const AudioDeviceID defaultInput = DefaultDevice(kAudioHardwarePropertyDefaultInputDevice);
  const AudioDeviceID defaultOutput = DefaultDevice(kAudioHardwarePropertyDefaultOutputDevice);
  uint32_t idx = 0;
  for (AudioDeviceID device : devices) {
    const bool hasInput = DeviceHasInput(device);
    const bool hasOutput = DeviceHasOutput(device);
    if (!hasInput && !hasOutput) continue;
    NSString *name = CopyStringProperty(device, kAudioObjectPropertyName) ?: @"";
    NSString *uid = CopyStringProperty(device, kAudioDevicePropertyDeviceUID) ?: @"";
    for (const char *kind : { "input", "output" }) {
      const bool output = std::strcmp(kind, "output") == 0;
      if (output ? !hasOutput : !hasInput) continue;
      napi_value obj;
      napi_create_object(env, &obj);
      SetNamed(env, obj, "id", MakeNumber(env, device));
      SetNamed(env, obj, "uid", MakeString(env, uid.UTF8String));
      SetNamed(env, obj, "name", MakeString(env, name.UTF8String));
      SetNamed(env, obj, "kind", MakeString(env, kind));
      SetNamed(env, obj, "isDefault", MakeBool(env, output ? device == defaultOutput : device == defaultInput));
      SetNamed(env, obj, "isVirtual", MakeBool(env, IsVirtualName(name, kDefaultVirtualPattern)));
      SetNamed(env, obj, "isAlive", MakeBool(env, DeviceIsAlive(device)));
      SetNamed(env, obj, "sampleRate", MakeNumber(env, DeviceSampleRate(device)));
      SetNamed(env, obj, "channels", MakeNumber(env, DeviceChannelCount(device, output ? kAudioDevicePropertyScopeOutput : kAudioDevicePropertyScopeInput)));
      napi_set_element(env, array, idx++, obj);
    }
  }
  return array;
}

}  // namespace babelvoice
