// RAII owner for an AudioConverterRef. Plain C++ over the AudioToolbox C API.
#pragma once

#include <AudioToolbox/AudioConverter.h>

namespace babelvoice {

class ScopedAudioConverter {
 public:
  ScopedAudioConverter() = default;
  ~ScopedAudioConverter() { Reset(); }
  ScopedAudioConverter(const ScopedAudioConverter &) = delete;
  ScopedAudioConverter &operator=(const ScopedAudioConverter &) = delete;

  AudioConverterRef get() const { return converter_; }
  explicit operator bool() const { return converter_ != nullptr; }
  // Takes ownership of a converter AudioConverterNew created.
  void Adopt(AudioConverterRef converter) {
    Reset();
    converter_ = converter;
  }
  void Reset() {
    if (converter_) AudioConverterDispose(converter_);
    converter_ = nullptr;
  }

 private:
  AudioConverterRef converter_ = nullptr;
};

}  // namespace babelvoice
