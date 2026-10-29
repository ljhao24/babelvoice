import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store/app-store.js';
import { hasEscapeLayer } from '../lib/escape-stack.js';
import { useSpeakSession } from './useSpeakSession.js';

/**
 * Global hotkey behaviour: press once to start, press again to stop.
 */
export const useGlobalHotkey = (): void => {
  const { t } = useTranslation('toast');
  const speakActive = useAppStore((s) => s.speak.active);
  const { toggle, stop } = useSpeakSession();

  useEffect(() => {
    const unsub = window.babelVoiceBridge.onHotkeyPressed(() => {
      const { currentMeeting, pushToast, speak } = useAppStore.getState();
      // Idle press needs an open meeting to start a session; once a
      // session is in flight, the same press toggles it off no matter
      // the meeting state, so the user never gets stuck "on" because
      // their meeting context drifted.
      if (!currentMeeting && !speak.active && speak.status !== 'connecting') {
        pushToast(t('openMeetingFirst'));
        return;
      }
      void toggle();
    });
    return () => {
      unsub();
    };
  }, [toggle, t]);

  useEffect(() => {
    if (!speakActive) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      // An open dialog owns Esc (it closes the dialog, nothing else).
      if (e.key === 'Escape' && !hasEscapeLayer()) {
        e.preventDefault();
        void stop();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [speakActive, stop]);
};
