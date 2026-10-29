#include "sck_capture.h"

#import <CoreMedia/CoreMedia.h>
#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "capture_sink.h"
#include "diagnostics.h"
#include "napi_util.h"
#include "promise_settler.h"
#include "scoped_cf.h"

namespace babelvoice {
namespace sck {

std::string NSErrorMessage(NSError *error, const char *fallback) {
  NSString *description = error.localizedDescription;
  if (description.length > 0) return std::string(description.UTF8String);
  return std::string(fallback);
}

int16_t ClampToInt16(float sample) {
  const float clipped = std::max(-1.0f, std::min(1.0f, sample));
  return static_cast<int16_t>(std::lrintf(clipped * 32767.0f));
}

// SCK sample queue. Mixes any LinearPCM layout SCK hands us down to mono
// Int16.
bool ConvertSampleBufferToInt16(CMSampleBufferRef sampleBuffer, PcmPacketPtr &packetOut) {
  if (!CMSampleBufferDataIsReady(sampleBuffer)) return false;
  CMFormatDescriptionRef format = CMSampleBufferGetFormatDescription(sampleBuffer);
  if (!format) return false;
  const AudioStreamBasicDescription *asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format);
  if (!asbd || asbd->mFormatID != kAudioFormatLinearPCM) return false;

  const CMItemCount frames = CMSampleBufferGetNumSamples(sampleBuffer);
  if (frames <= 0) return false;

  AudioBufferList stackList;
  AudioBufferList *bufferList = &stackList;
  ScopedCFRef<CMBlockBufferRef> blockBuffer;
  OSStatus status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
    sampleBuffer,
    nullptr,
    bufferList,
    sizeof(stackList),
    nullptr,
    nullptr,
    kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
    blockBuffer.Out()
  );

  std::vector<uint8_t> dynamicListStorage;
  if (status == kCMSampleBufferError_ArrayTooSmall) {
    size_t needed = 0;
    status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
      sampleBuffer,
      &needed,
      nullptr,
      0,
      nullptr,
      nullptr,
      kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
      blockBuffer.Out()
    );
    blockBuffer.Reset();
    if (status != noErr || needed == 0) return false;
    dynamicListStorage.resize(needed);
    bufferList = reinterpret_cast<AudioBufferList *>(dynamicListStorage.data());
    status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
      sampleBuffer,
      nullptr,
      bufferList,
      needed,
      nullptr,
      nullptr,
      kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
      blockBuffer.Out()
    );
  }
  if (status != noErr) return false;

  const bool isFloat = (asbd->mFormatFlags & kAudioFormatFlagIsFloat) != 0;
  const bool isSignedInteger = (asbd->mFormatFlags & kAudioFormatFlagIsSignedInteger) != 0;
  const UInt32 channels = std::max<UInt32>(1, asbd->mChannelsPerFrame);
  const UInt32 bytesPerSample = std::max<UInt32>(1, asbd->mBitsPerChannel / 8);
  const bool nonInterleaved = bufferList->mNumberBuffers > 1;

  PcmPacketPtr packet = AllocPacket(static_cast<size_t>(frames) * sizeof(int16_t));
  if (!packet) return false;
  int16_t *out = static_cast<int16_t *>(packet->bytes);

  for (CMItemCount frame = 0; frame < frames; frame++) {
    float mixed = 0.0f;
    UInt32 availableChannels = 0;
    for (UInt32 channel = 0; channel < channels; channel++) {
      UInt32 bufferIndex = nonInterleaved ? std::min(channel, bufferList->mNumberBuffers - 1) : 0;
      const AudioBuffer &buf = bufferList->mBuffers[bufferIndex];
      if (!buf.mData || buf.mDataByteSize == 0) continue;
      const uint8_t *base = static_cast<const uint8_t *>(buf.mData);
      size_t sampleIndex = nonInterleaved ? static_cast<size_t>(frame) : static_cast<size_t>(frame) * channels + channel;
      const uint8_t *ptr = base + sampleIndex * bytesPerSample;
      float value = 0.0f;
      if (isFloat && bytesPerSample == 4) {
        float tmp;
        std::memcpy(&tmp, ptr, sizeof(tmp));
        value = tmp;
      } else if (isSignedInteger && bytesPerSample == 2) {
        int16_t tmp;
        std::memcpy(&tmp, ptr, sizeof(tmp));
        value = static_cast<float>(tmp) / 32768.0f;
      } else if (isSignedInteger && bytesPerSample == 4) {
        int32_t tmp;
        std::memcpy(&tmp, ptr, sizeof(tmp));
        value = static_cast<float>(tmp) / 2147483648.0f;
      } else {
        continue;
      }
      mixed += value;
      availableChannels++;
    }
    out[frame] = ClampToInt16(availableChannels > 0 ? mixed / availableChannels : 0.0f);
  }

  packetOut = std::move(packet);
  return true;
}

}  // namespace sck
}  // namespace babelvoice

@interface BabelVoiceCaptureOutput : NSObject <SCStreamOutput>
- (instancetype)initWithSink:(std::shared_ptr<babelvoice::CaptureSink>)sink;
@end

@implementation BabelVoiceCaptureOutput {
  std::shared_ptr<babelvoice::CaptureSink> _sink;
}

- (instancetype)initWithSink:(std::shared_ptr<babelvoice::CaptureSink>)sink {
  if ((self = [super init])) {
    _sink = std::move(sink);
  }
  return self;
}

// Runs on the capture's private serial queue: chunks reach JS in order and
// the listen diagnostics have a single writer.
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer ofType:(SCStreamOutputType)type {
  (void)stream;
  if (type != SCStreamOutputTypeAudio || !_sink->accepting.load(std::memory_order_acquire)) return;
  babelvoice::PcmPacketPtr packet;
  if (!babelvoice::sck::ConvertSampleBufferToInt16(sampleBuffer, packet)) return;
  babelvoice::UpdateDiagnostics(babelvoice::ListenDiagnostics(), packet->bytes, packet->length, "capturing");
  _sink->PostPcm(std::move(packet));
}
@end

// Without a delegate, SCK failures (permission revoked, display removed,
// replayd crash, the user stopping capture from the menu bar) never reached
// JS and listen mode silently went quiet.
@interface BabelVoiceStreamDelegate : NSObject <SCStreamDelegate>
- (instancetype)initWithSink:(std::shared_ptr<babelvoice::CaptureSink>)sink;
@end

@implementation BabelVoiceStreamDelegate {
  std::shared_ptr<babelvoice::CaptureSink> _sink;
}

- (instancetype)initWithSink:(std::shared_ptr<babelvoice::CaptureSink>)sink {
  if ((self = [super init])) {
    _sink = std::move(sink);
  }
  return self;
}

- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
  (void)stream;
  const std::string message =
    "系统音频采集已中断：" + babelvoice::sck::NSErrorMessage(error, "ScreenCaptureKit stream stopped");
  _sink->PostError(message.c_str());
}
@end

namespace babelvoice {

namespace {

using sck::NSErrorMessage;

// ---------------------------------------------------------------------------
// Start is asynchronous: getShareableContent and startCapture each complete
// on SCK's own queues and can stall for seconds (first-run TCC, replayd
// restart), so JS gets a promise instead of the main thread blocking on
// semaphores. SCK callbacks only touch SckCapture state under its mutex.
// ---------------------------------------------------------------------------

enum class SckState { Starting, Running, Failed, Stopped };

struct SckCapture {
  std::mutex mutex;
  Float64 sampleRate = kDefaultCaptureSampleRate;  // immutable after creation
  SckState state = SckState::Starting;           // guarded by mutex
  SCStream *stream = nil;                        // guarded by mutex
  BabelVoiceCaptureOutput *output = nil;         // guarded by mutex
  BabelVoiceStreamDelegate *delegate = nil;      // guarded by mutex
  std::shared_ptr<PromiseSettler> startSettler;  // guarded by mutex
  // Immutable after creation.
  std::shared_ptr<CaptureSink> sink;
  // Serial: PCM chunks reach JS in order and diagnostics have one writer.
  dispatch_queue_t sampleQueue = nil;
};

// JS thread only.
struct SckSlot {
  std::shared_ptr<SckCapture> current;
};

SckSlot &Slot() {
  static SckSlot *const slot = new SckSlot();
  return *slot;
}

constexpr int64_t kSckStartTimeoutNs = 15 * NSEC_PER_SEC;
constexpr int64_t kSckStopTimeoutNs = 3 * NSEC_PER_SEC;

// cap.mutex held.
void SckSettleStartLocked(SckCapture &cap, bool ok, const std::string &message) {
  if (!cap.startSettler) return;
  Settle(cap.startSettler, ok, message);
  cap.startSettler.reset();
}

void SckStopStreamAsync(SCStream *stream) {
  if (!stream) return;
  [stream stopCaptureWithCompletionHandler:^(NSError *) {
    (void)stream;
  }];
}

void SckOnStarted(const std::shared_ptr<SckCapture> &cap, SCStream *stream, NSError *error) {
  bool orphaned = false;
  {
    std::lock_guard<std::mutex> lock(cap->mutex);
    if (cap->state == SckState::Starting) {
      if (error) {
        cap->state = SckState::Failed;
        cap->stream = nil;
        SckSettleStartLocked(*cap, false, NSErrorMessage(error, "ScreenCaptureKit failed to start"));
      } else {
        cap->state = SckState::Running;
        SckSettleStartLocked(*cap, true, "");
      }
    } else {
      // Timed out or stopped while SCK was still starting: don't leave a
      // stream capturing with nobody listening.
      orphaned = error == nil;
    }
  }
  if (orphaned) SckStopStreamAsync(stream);
}

void SckOnShareableContent(const std::shared_ptr<SckCapture> &cap, SCShareableContent *content, NSError *error) {
  {
    std::lock_guard<std::mutex> lock(cap->mutex);
    if (cap->state != SckState::Starting) return;
    if (error || content.displays.count == 0) {
      cap->state = SckState::Failed;
      SckSettleStartLocked(*cap, false, NSErrorMessage(error, "ScreenCaptureKit shareable content unavailable"));
      return;
    }
  }

  SCDisplay *display = content.displays.firstObject;
  SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]];
  SCStreamConfiguration *config = [[SCStreamConfiguration alloc] init];
  config.capturesAudio = YES;
  config.excludesCurrentProcessAudio = YES;
  config.sampleRate = static_cast<NSInteger>(cap->sampleRate);
  config.channelCount = 1;
  // We only want audio, but SCK always runs the video pipeline: keep it to
  // one 2x2 frame per second with a shallow queue so it costs ~nothing.
  config.width = 2;
  config.height = 2;
  config.minimumFrameInterval = CMTimeMake(1, 1);
  config.queueDepth = 3;
  config.showsCursor = NO;

  BabelVoiceCaptureOutput *output = [[BabelVoiceCaptureOutput alloc] initWithSink:cap->sink];
  BabelVoiceStreamDelegate *delegate = [[BabelVoiceStreamDelegate alloc] initWithSink:cap->sink];
  SCStream *stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:delegate];
  NSError *outputError = nil;
  const BOOL added = [stream addStreamOutput:output
                                        type:SCStreamOutputTypeAudio
                          sampleHandlerQueue:cap->sampleQueue
                                       error:&outputError];
  {
    std::lock_guard<std::mutex> lock(cap->mutex);
    if (cap->state != SckState::Starting) return;
    if (!added || outputError) {
      cap->state = SckState::Failed;
      SckSettleStartLocked(*cap, false, NSErrorMessage(outputError, "failed to add ScreenCaptureKit audio output"));
      return;
    }
    cap->stream = stream;
    cap->output = output;
    cap->delegate = delegate;
  }
  // Blocks capture C++ references by reference, and `cap` points into the
  // getShareableContent completion block, which SCK frees once it returns.
  // Own a copy so the startCapture completion never sees a dangling ref.
  std::shared_ptr<SckCapture> owned = cap;
  [stream startCaptureWithCompletionHandler:^(NSError *startError) {
    SckOnStarted(owned, stream, startError);
  }];
}

void SckOnStartTimeout(const std::shared_ptr<SckCapture> &cap) {
  SCStream *stream = nil;
  {
    std::lock_guard<std::mutex> lock(cap->mutex);
    if (cap->state != SckState::Starting) return;
    cap->state = SckState::Failed;
    stream = cap->stream;
    cap->stream = nil;
    SckSettleStartLocked(*cap, false, "ScreenCaptureKit start timed out");
  }
  // startCapture may still complete later; SckOnStarted stops it then too.
  SckStopStreamAsync(stream);
}

// JS thread. Cuts the JS callbacks off right away and hands back the stream
// that still needs stopCapture, if any.
SCStream *SckBeginStop(const std::shared_ptr<SckCapture> &cap, bool releaseJs) {
  cap->sink->BeginStop();
  SCStream *stream = nil;
  {
    std::lock_guard<std::mutex> lock(cap->mutex);
    if (cap->state == SckState::Starting) {
      SckSettleStartLocked(*cap, false, "system audio capture was stopped before it started");
    }
    cap->state = SckState::Stopped;
    stream = cap->stream;
    cap->stream = nil;
  }
  if (releaseJs) {
    cap->sink->Release();
  } else {
    cap->sink->Detach();
  }
  SetRouteStatus(ListenDiagnostics(), "idle");
  return stream;
}

// Env-teardown path (TSFN finalizer / CleanupNativeBridge): never releases.
// The sink is detached, so late sample callbacks are dropped; the stream is
// stopped asynchronously.
void StopSckNow() {
  SckSlot &slot = Slot();
  if (!slot.current) return;
  std::shared_ptr<SckCapture> cap = std::move(slot.current);
  SckStopStreamAsync(SckBeginStop(cap, false));
}

void StopSckIfCurrent(CaptureSink *sink) {
  SckSlot &slot = Slot();
  if (slot.current && slot.current->sink.get() == sink) StopSckNow();
}

}  // namespace

// startSystemAudioCapture(onPcm, onError?, sampleRate?) -> Promise<void>
napi_value StartSystemAudioCapture(napi_env env, napi_callback_info info) {
  if (!@available(macOS 14.0, *)) {
    Throw(env, "macOS 14.0 or newer is required for native audio isolation");
    return nullptr;
  }
  SckSlot &slot = Slot();
  if (slot.current) {
    Throw(env, "system audio capture is already running");
    return nullptr;
  }

  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1) {
    Throw(env, "startSystemAudioCapture requires a callback");
    return nullptr;
  }
  napi_valuetype type;
  napi_typeof(env, args[0], &type);
  if (type != napi_function) {
    Throw(env, "startSystemAudioCapture callback must be a function");
    return nullptr;
  }
  napi_value onError = OptionalFunctionArg(env, args, argc, 1);
  Float64 sampleRate = kDefaultCaptureSampleRate;
  if (!CaptureSampleRateArg(env, args, argc, 2, sampleRate)) return nullptr;

  auto cap = std::make_shared<SckCapture>();
  cap->sampleRate = sampleRate;
  cap->sink = CreateCaptureSink(env, args[0], onError, "BabelVoiceSystemAudioCapture", StopSckIfCurrent);
  if (!cap->sink) {
    Throw(env, "failed to create capture callback");
    return nullptr;
  }
  napi_value promise;
  std::shared_ptr<PromiseSettler> settler = CreateSettler(env, "BabelVoiceSystemAudioStart", &promise);
  if (!settler) {
    cap->sink->Release();
    Throw(env, "failed to create capture promise");
    return nullptr;
  }
  // A failed start leaves nothing for JS to stop: free the slot here so the
  // next start isn't refused as "already running". weak_ptr: the settler is
  // owned by the capture.
  std::weak_ptr<SckCapture> weakCap = cap;
  settler->onSettledJs = [weakCap](bool ok) {
    if (ok) return;
    std::shared_ptr<SckCapture> failed = weakCap.lock();
    if (!failed) return;
    SckSlot &current = Slot();
    if (current.current == failed) {
      current.current.reset();
      SetRouteStatus(ListenDiagnostics(), "idle");
    }
    failed->sink->Release();
  };
  cap->startSettler = settler;
  cap->sampleQueue = dispatch_queue_create(
    "com.babelvoice.sck-audio",
    dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL, QOS_CLASS_USER_INITIATED, 0));
  slot.current = cap;
  SetRouteStatus(ListenDiagnostics(), "starting");

  [SCShareableContent getShareableContentExcludingDesktopWindows:NO
                                             onScreenWindowsOnly:YES
                                               completionHandler:^(SCShareableContent *content, NSError *error) {
    SckOnShareableContent(cap, content, error);
  }];
  dispatch_after(
    dispatch_time(DISPATCH_TIME_NOW, kSckStartTimeoutNs),
    dispatch_get_global_queue(QOS_CLASS_UTILITY, 0),
    ^{ SckOnStartTimeout(cap); });
  return promise;
}

// stopSystemAudioCapture() -> Promise<void>. JS callbacks stop immediately;
// the promise resolves once SCK confirms the stop and the sample queue has
// drained, or after a timeout so a wedged replayd can't hang the caller.
napi_value StopSystemAudioCapture(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value promise;
  std::shared_ptr<PromiseSettler> settler = CreateSettler(env, "BabelVoiceSystemAudioStop", &promise);
  if (!settler) {
    Throw(env, "failed to create stop promise");
    return nullptr;
  }
  SckSlot &slot = Slot();
  if (!slot.current) {
    Settle(settler, true, "");
    return promise;
  }
  std::shared_ptr<SckCapture> cap = std::move(slot.current);
  SCStream *stream = SckBeginStop(cap, true);
  if (!stream) {
    Settle(settler, true, "");
    return promise;
  }
  dispatch_queue_t sampleQueue = cap->sampleQueue;
  [stream stopCaptureWithCompletionHandler:^(NSError *) {
    // Queue behind any sample callback already in flight, then resolve.
    // Captures keep the stream/output/delegate alive until SCK is done.
    dispatch_async(sampleQueue, ^{
      (void)cap;
      (void)stream;
      Settle(settler, true, "");
    });
  }];
  dispatch_after(
    dispatch_time(DISPATCH_TIME_NOW, kSckStopTimeoutNs),
    dispatch_get_global_queue(QOS_CLASS_UTILITY, 0),
    ^{ Settle(settler, true, ""); });
  return promise;
}

void StopSystemAudioForTeardown() {
  StopSckNow();
}

}  // namespace babelvoice
