#include "pcm_resampler.h"

#include <algorithm>
#include <cmath>

namespace babelvoice {

namespace {

// Non-zero from the input proc means "no more input right now" without
// ending the stream: frames already produced are returned and the filter
// state is kept for the next call (noErr + 0 packets would mean EOF).
constexpr OSStatus kNoMoreInputNow = -1;

AudioStreamBasicDescription Int16Mono(double sampleRate) {
  AudioStreamBasicDescription asbd{};
  asbd.mSampleRate = sampleRate;
  asbd.mFormatID = kAudioFormatLinearPCM;
  asbd.mFormatFlags = kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked;
  asbd.mFramesPerPacket = 1;
  asbd.mChannelsPerFrame = 1;
  asbd.mBitsPerChannel = 16;
  asbd.mBytesPerFrame = 2;
  asbd.mBytesPerPacket = 2;
  return asbd;
}

}  // namespace

std::unique_ptr<PcmResampler> PcmResampler::Create(double inputRate, double outputRate, uint32_t maxInputFrames) {
  if (inputRate <= 0 || outputRate <= 0 || inputRate == outputRate || maxInputFrames == 0) return nullptr;
  const AudioStreamBasicDescription input = Int16Mono(inputRate);
  const AudioStreamBasicDescription output = Int16Mono(outputRate);
  AudioConverterRef converter = nullptr;
  if (AudioConverterNew(&input, &output, &converter) != noErr || !converter) return nullptr;

  std::unique_ptr<PcmResampler> resampler(new PcmResampler());
  resampler->converter_.Adopt(converter);
  // Explicit rather than whatever the default is: 24 → 16 kHz has to drop
  // the 8–12 kHz band without aliasing. Measured on 24k → 16k: Normal is
  // -3 dB at 7 kHz, Mastering flat to 7.5 kHz and still under 0.2% of one
  // core for a mono stream (~180 µs worst case per 40 ms chunk).
  UInt32 complexity = kAudioConverterSampleRateConverterComplexity_Mastering;
  AudioConverterSetProperty(converter, kAudioConverterSampleRateConverterComplexity, sizeof(complexity), &complexity);
  UInt32 quality = kAudioConverterQuality_High;
  AudioConverterSetProperty(converter, kAudioConverterSampleRateConverterQuality, sizeof(quality), &quality);

  resampler->inputRate_ = inputRate;
  resampler->outputRate_ = outputRate;
  resampler->maxInputFrames_ = maxInputFrames;
  // Room for well over one chunk's output, so the converter always drains
  // the whole input (and asks for more) before the buffer fills — see
  // Convert().
  const double perChunk = std::ceil(static_cast<double>(maxInputFrames) * outputRate / inputRate);
  resampler->output_.assign(static_cast<size_t>(2 * perChunk) + 256, 0);

  // Prime with one chunk of silence: any lazy allocation inside the
  // converter happens here, on the JS thread, and the filter starts from a
  // silent history.
  std::vector<int16_t> silence(maxInputFrames, 0);
  resampler->Convert(silence.data(), maxInputFrames);
  return resampler;
}

OSStatus PcmResampler::Fill(
  AudioConverterRef,
  UInt32 *ioNumberDataPackets,
  AudioBufferList *ioData,
  AudioStreamPacketDescription **,
  void *inUserData
) {
  PendingInput *pending = static_cast<PendingInput *>(inUserData);
  if (pending->consumed || pending->frames == 0 || ioData->mNumberBuffers == 0) {
    *ioNumberDataPackets = 0;
    return kNoMoreInputNow;
  }
  ioData->mNumberBuffers = 1;
  ioData->mBuffers[0].mNumberChannels = 1;
  ioData->mBuffers[0].mData = const_cast<int16_t *>(pending->samples);
  ioData->mBuffers[0].mDataByteSize = pending->frames * static_cast<UInt32>(sizeof(int16_t));
  *ioNumberDataPackets = pending->frames;
  pending->consumed = true;
  return noErr;
}

uint32_t PcmResampler::Convert(const int16_t *input, uint32_t frames) {
  if (!input || frames == 0 || !converter_) return 0;
  PendingInput pending{input, std::min(frames, maxInputFrames_), false};
  const uint32_t capacity = static_cast<uint32_t>(output_.size());
  uint32_t produced = 0;
  // One pass in practice. The converter must never be left holding part of
  // the input: it would keep a pointer into an AudioQueue buffer that gets
  // recycled right after this callback. Ending on kNoMoreInputNow proves it
  // consumed everything; the output buffer is sized so it gets there first.
  while (produced < capacity) {
    UInt32 outFrames = capacity - produced;
    AudioBufferList outList;
    outList.mNumberBuffers = 1;
    outList.mBuffers[0].mNumberChannels = 1;
    outList.mBuffers[0].mDataByteSize = outFrames * static_cast<UInt32>(sizeof(int16_t));
    outList.mBuffers[0].mData = output_.data() + produced;
    const OSStatus err = AudioConverterFillComplexBuffer(converter_.get(), Fill, &pending, &outFrames, &outList, nullptr);
    produced += outFrames;
    if (err != noErr || outFrames == 0) break;
  }
  return produced;
}

}  // namespace babelvoice
