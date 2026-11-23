// Match our custom-branded BabelVoice driver. We also match upstream BlackHole
// labels so users with the original driver still installed see it work — the
// install button always installs BabelVoice, not BlackHole. On Windows the
// virtual loopback is VB-Cable ("CABLE Input/Output (VB-Audio Virtual Cable)").
export const VIRTUAL_AUDIO_LABEL_RE = /babelvoice|blackhole|vb-audio|cable (input|output)/i;
export const VIRTUAL_AUDIO_DISPLAY_NAME = 'BabelVoice';

export const isVirtualAudioDevice = (
  d: MediaDeviceInfo | undefined
): boolean => !!d && VIRTUAL_AUDIO_LABEL_RE.test(d.label);
