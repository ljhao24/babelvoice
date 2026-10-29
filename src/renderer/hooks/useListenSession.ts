import { useCallback, useMemo } from 'react';
import type { StartTranslationParams } from '../../shared/ipc-types.js';
import { isListenPlaybackActive } from '../../shared/config-types.js';
import { useAppStore } from '../store/app-store.js';
import {
  useDirectionSession,
  type DirectionSessionControls
} from './useDirectionSession.js';

interface ListenSessionOptions {
  /**
   * Listen to the whole system rather than the configured source app, with
   * subtitles only (see `StartTranslationParams.captureSystemAudio`). For
   * the test panel, whose clips play from BabelVoice itself.
   */
  captureSystemAudio?: boolean;
}

/**
 * Continuous listen pipeline (meeting → user). Subtitles always; TTS for the
 * translation is opt-in (mode=s2s) and needs a tapped source app — see
 * `isListenPlaybackActive`. The listen-direction main sink stays no-op, so
 * any TTS PCM only reaches the renderer (`useTtsMonitor`) and never the
 * meeting's virtual mic.
 */
export const useListenSession = ({
  captureSystemAudio = false
}: ListenSessionOptions = {}): Pick<DirectionSessionControls, 'start' | 'stop'> => {
  const preferences = useAppStore((s) => s.preferences);

  const buildStartParams = useCallback(
    (): StartTranslationParams => ({
      direction: 'listen',
      sourceLanguage: preferences.meetingLanguage,
      targetLanguage: preferences.mySpokenLanguage,
      mode: !captureSystemAudio && isListenPlaybackActive(preferences) ? 's2s' : 's2t',
      ...(captureSystemAudio ? { captureSystemAudio: true } : {})
    }),
    [preferences, captureSystemAudio]
  );

  const { start, stop } = useDirectionSession('listen', buildStartParams);
  return useMemo(() => ({ start, stop }), [start, stop]);
};
