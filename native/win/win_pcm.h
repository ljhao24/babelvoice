// PCM conversion for the WASAPI subsystems: a streaming windowed-sinc
// resampler (the AudioConverter replacement) and a capture-format converter
// that turns whatever an IAudioClient delivers into mono Int16 at the rate
// a consumer asked for. Plain C++; one thread at a time per instance.
#pragma once

#include "win_common.h"

#include <mmreg.h>

#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>

namespace babelvoice {

// Mono float in, mono Int16 out, any rate ratio. Filter state carries over
// between calls, so consecutive chunks form one continuous stream. Adds
// half a filter of latency (~1-3 ms) at the start.
class StreamResampler {
 public:
  StreamResampler(double inputRate, double outputRate);

  // Appends the converted samples to `out`.
  void Process(const float *input, size_t frames, std::vector<int16_t> &out);
  void ProcessInt16(const int16_t *input, size_t frames, std::vector<int16_t> &out);

  double inputRate() const { return inputRate_; }
  double outputRate() const { return outputRate_; }

 private:
  void Drain(std::vector<int16_t> &out);

  double inputRate_;
  double outputRate_;
  double step_;       // input samples per output sample
  double cutoff_;     // normalized to the input Nyquist
  double halfWidth_;  // kernel half-width in input samples
  std::vector<float> history_;
  double position_;   // next output's position in history_
  std::vector<float> scratch_;
};

// Interleaved capture packets (float32 / Int16 / Int24 / Int32, any channel
// count, any rate) -> mono Int16 at `outputRate`.
class CaptureConverter {
 public:
  // nullptr for a format we can't read.
  static std::unique_ptr<CaptureConverter> Create(const WAVEFORMATEX *format, double outputRate);

  // `silent` = AUDCLNT_BUFFERFLAGS_SILENT: treat the packet as zeros.
  void Process(const BYTE *data, uint32_t frames, bool silent, std::vector<int16_t> &out);

 private:
  CaptureConverter() = default;

  enum class Sample { Float32, Int16, Int24, Int32 };
  Sample sample_ = Sample::Float32;
  uint32_t channels_ = 1;
  uint32_t blockAlign_ = 0;
  double inputRate_ = 0;
  double outputRate_ = 0;
  std::unique_ptr<StreamResampler> resampler_;  // null: rates equal
  std::vector<float> mono_;
};

inline int16_t FloatToInt16(float value) {
  const float scaled = value * 32767.0f;
  if (scaled >= 32767.0f) return 32767;
  if (scaled <= -32768.0f) return -32768;
  return static_cast<int16_t>(scaled < 0 ? scaled - 0.5f : scaled + 0.5f);
}

// Mono Int16 at `rate` — the format we ask WASAPI for when it can convert
// for us (AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM).
WAVEFORMATEX MonoInt16Format(double rate);

}  // namespace babelvoice
