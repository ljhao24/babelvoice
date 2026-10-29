import { useCallback } from 'react';
import type { StartTranslationParams } from '../../shared/ipc-types.js';
import { useAppStore } from '../store/app-store.js';
import {
  useDirectionSession,
  type DirectionSessionControls
} from './useDirectionSession.js';

/**
 * PTT speak pipeline (zh → en, mode=s2s). Microphone capture and TTS
 * playback live in the native bridge — the renderer never touches PCM.
 * Microphone selection passes a CoreAudio device UID through
 * `microphoneDeviceUid`.
 */
export const useSpeakSession = (): DirectionSessionControls => {
  const preferences = useAppStore((s) => s.preferences);

  const buildStartParams = useCallback(
    (): StartTranslationParams => ({
      direction: 'speak',
      sourceLanguage: preferences.mySpokenLanguage,
      targetLanguage: preferences.meetingLanguage,
      mode: 's2s'
    }),
    [preferences.mySpokenLanguage, preferences.meetingLanguage]
  );

  return useDirectionSession('speak', buildStartParams);
};
