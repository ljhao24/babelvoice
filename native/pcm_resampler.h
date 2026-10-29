// Streaming Int16 mono sample-rate converter for one consumer of the shared
// microphone capture. Plain C++ over the AudioToolbox C API.
//
// Real-time contract: Create() (JS thread) allocates everything and primes
// the converter so its lazy internal allocations happen there too; Convert()
// (AudioQueue thread) then never allocates, locks or calls into ObjC. One
// thread at a time may call Convert().
#pragma once

#include <cstdint>
#include <memory>
#include <vector>

#include "scoped_audio_converter.h"

namespace babelvoice {

class PcmResampler {
 public:
  // nullptr when the rates are equal / invalid or the converter can't be
  // built. `maxInputFrames` bounds one Convert() call.
  static std::unique_ptr<PcmResampler> Create(double inputRate, double outputRate, uint32_t maxInputFrames);

  // Converts one chunk of the input stream; returns the number of frames now
  // in output(). Filter state carries over between calls, so consecutive
  // chunks form one continuous stream. Input beyond maxInputFrames is
  // ignored (never happens with the AudioQueue buffers it is sized for).
  uint32_t Convert(const int16_t *input, uint32_t frames);
  const int16_t *output() const { return output_.data(); }

  double inputRate() const { return inputRate_; }
  double outputRate() const { return outputRate_; }

 private:
  PcmResampler() = default;

  struct PendingInput {
    const int16_t *samples;
    uint32_t frames;
    bool consumed;
  };
  static OSStatus Fill(
    AudioConverterRef,
    UInt32 *ioNumberDataPackets,
    AudioBufferList *ioData,
    AudioStreamPacketDescription **,
    void *inUserData);

  ScopedAudioConverter converter_;
  std::vector<int16_t> output_;
  uint32_t maxInputFrames_ = 0;
  double inputRate_ = 0;
  double outputRate_ = 0;
};

}  // namespace babelvoice
