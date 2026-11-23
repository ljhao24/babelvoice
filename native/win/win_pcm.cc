#include "win_pcm.h"

#include <ks.h>
#include <ksmedia.h>

#include <algorithm>
#include <cmath>
#include <cstring>

namespace babelvoice {

namespace {

constexpr double kPi = 3.14159265358979323846;
// Kernel half-width, in output-rate zero crossings. 16 keeps the stopband
// well below the Int16 noise floor of speech at negligible cost.
constexpr double kZeroCrossings = 16;

double Sinc(double x) {
  if (std::fabs(x) < 1e-9) return 1.0;
  return std::sin(kPi * x) / (kPi * x);
}

// Blackman window over r in [-1, 1].
double Window(double r) {
  if (r <= -1.0 || r >= 1.0) return 0.0;
  return 0.42 + 0.5 * std::cos(kPi * r) + 0.08 * std::cos(2 * kPi * r);
}

}  // namespace

StreamResampler::StreamResampler(double inputRate, double outputRate)
    : inputRate_(inputRate), outputRate_(outputRate) {
  step_ = inputRate / outputRate;
  // Downsampling: low-pass at the output Nyquist (a little under, for the
  // transition band). Upsampling: the input Nyquist.
  cutoff_ = std::min(1.0, outputRate / inputRate) * 0.95;
  halfWidth_ = kZeroCrossings / cutoff_;
  // Prime with silence so the first outputs have their left context.
  const size_t lead = static_cast<size_t>(std::ceil(halfWidth_));
  history_.assign(lead, 0.0f);
  position_ = static_cast<double>(lead);
}

void StreamResampler::Process(const float *input, size_t frames, std::vector<int16_t> &out) {
  history_.insert(history_.end(), input, input + frames);
  Drain(out);
}

void StreamResampler::ProcessInt16(const int16_t *input, size_t frames, std::vector<int16_t> &out) {
  scratch_.resize(frames);
  for (size_t i = 0; i < frames; i++) scratch_[i] = input[i] / 32768.0f;
  Process(scratch_.data(), frames, out);
}

void StreamResampler::Drain(std::vector<int16_t> &out) {
  const double size = static_cast<double>(history_.size());
  while (position_ + halfWidth_ < size) {
    const long first = static_cast<long>(std::ceil(position_ - halfWidth_));
    const long last = static_cast<long>(std::floor(position_ + halfWidth_));
    double acc = 0;
    double norm = 0;
    for (long n = std::max(0L, first); n <= last; n++) {
      const double distance = static_cast<double>(n) - position_;
      const double weight = cutoff_ * Sinc(cutoff_ * distance) * Window(distance / halfWidth_);
      acc += history_[static_cast<size_t>(n)] * weight;
      norm += weight;
    }
    // Normalizing by the kernel sum keeps the DC gain exactly 1 at every
    // fractional phase.
    out.push_back(FloatToInt16(static_cast<float>(norm != 0 ? acc / norm : 0)));
    position_ += step_;
  }
  // Keep only the left context the next output still needs.
  const long keepFrom = static_cast<long>(std::floor(position_ - halfWidth_)) - 1;
  if (keepFrom > 0) {
    history_.erase(history_.begin(), history_.begin() + std::min<long>(keepFrom, static_cast<long>(history_.size())));
    position_ -= static_cast<double>(keepFrom);
  }
}

std::unique_ptr<CaptureConverter> CaptureConverter::Create(const WAVEFORMATEX *format, double outputRate) {
  if (!format || format->nChannels == 0 || format->nSamplesPerSec == 0) return nullptr;
  std::unique_ptr<CaptureConverter> converter(new CaptureConverter());
  bool isFloat = format->wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
  bool isPcm = format->wFormatTag == WAVE_FORMAT_PCM;
  uint32_t validBits = format->wBitsPerSample;
  if (format->wFormatTag == WAVE_FORMAT_EXTENSIBLE && format->cbSize >= 22) {
    const auto *ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE *>(format);
    isFloat = IsEqualGUID(ext->SubFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT) != 0;
    isPcm = IsEqualGUID(ext->SubFormat, KSDATAFORMAT_SUBTYPE_PCM) != 0;
    if (ext->Samples.wValidBitsPerSample) validBits = ext->Samples.wValidBitsPerSample;
  }
  const uint32_t container = format->wBitsPerSample;
  if (isFloat && container == 32) {
    converter->sample_ = Sample::Float32;
  } else if (isPcm && container == 16) {
    converter->sample_ = Sample::Int16;
  } else if (isPcm && container == 24) {
    converter->sample_ = Sample::Int24;
  } else if (isPcm && container == 32) {
    converter->sample_ = Sample::Int32;  // 24-in-32 reads fine as Int32 too
  } else {
    return nullptr;
  }
  (void)validBits;
  converter->channels_ = format->nChannels;
  converter->blockAlign_ = format->nBlockAlign;
  converter->inputRate_ = format->nSamplesPerSec;
  converter->outputRate_ = outputRate;
  if (converter->inputRate_ != outputRate) {
    converter->resampler_ = std::make_unique<StreamResampler>(converter->inputRate_, outputRate);
  }
  return converter;
}

void CaptureConverter::Process(const BYTE *data, uint32_t frames, bool silent, std::vector<int16_t> &out) {
  mono_.assign(frames, 0.0f);
  if (!silent && data) {
    const float scale = 1.0f / static_cast<float>(channels_);
    for (uint32_t f = 0; f < frames; f++) {
      const BYTE *frame = data + static_cast<size_t>(f) * blockAlign_;
      float sum = 0;
      for (uint32_t c = 0; c < channels_; c++) {
        switch (sample_) {
          case Sample::Float32: {
            float v;
            std::memcpy(&v, frame + c * 4, 4);
            sum += v;
            break;
          }
          case Sample::Int16: {
            int16_t v;
            std::memcpy(&v, frame + c * 2, 2);
            sum += v / 32768.0f;
            break;
          }
          case Sample::Int24: {
            const BYTE *p = frame + c * 3;
            const uint32_t bits = (uint32_t{p[0]} << 8) | (uint32_t{p[1]} << 16) | (uint32_t{p[2]} << 24);
            sum += static_cast<float>(static_cast<int32_t>(bits) / 2147483648.0);
            break;
          }
          case Sample::Int32: {
            int32_t v;
            std::memcpy(&v, frame + c * 4, 4);
            sum += static_cast<float>(v / 2147483648.0);
            break;
          }
        }
      }
      mono_[f] = sum * scale;
    }
  }
  if (resampler_) {
    resampler_->Process(mono_.data(), mono_.size(), out);
  } else {
    for (float v : mono_) out.push_back(FloatToInt16(v));
  }
}

WAVEFORMATEX MonoInt16Format(double rate) {
  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = 1;
  format.nSamplesPerSec = static_cast<DWORD>(rate);
  format.wBitsPerSample = 16;
  format.nBlockAlign = 2;
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
  format.cbSize = 0;
  return format;
}

}  // namespace babelvoice
