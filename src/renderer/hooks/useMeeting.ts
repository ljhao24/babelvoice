import { useCallback, useEffect } from 'react';
import { useAppStore } from '../store/app-store.js';
import type { Meeting } from '@shared/meeting-types.js';

/**
 * Wires the store's `currentMeeting` to main: hydrate once, then follow the
 * auto-ended broadcast (idle timeout / app-quit doesn't reach us otherwise).
 *
 * Called once at the control-panel root (`useControlPanelWiring`) so the
 * subscription lives regardless of which page is showing — a meeting that
 * auto-ends while the user is on the 历史 page must still clear the store, and
 * switching pages must not re-hydrate (and reset) the live transcript.
 */
export function useMeetingWiring(): void {
  const setCurrent = useAppStore((s) => s.setCurrentMeeting);

  useEffect(() => {
    let cancelled = false;
    void window.babelVoiceBridge
      .getCurrentMeeting()
      .then((m) => {
        if (!cancelled) setCurrent(m);
      })
      .catch((err: unknown) => {
        console.warn('[meeting] getCurrentMeeting failed', err);
      });
    const unsub = window.babelVoiceBridge.onMeetingAutoEnded((ended) => {
      // Only drop the meeting that actually ended — a stale broadcast must
      // not close a newer meeting the user just opened.
      const current = useAppStore.getState().currentMeeting;
      if (current && (!ended || ended.id === current.id)) setCurrent(null);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [setCurrent]);
}

/**
 * Hook surface for meeting lifecycle commands. State comes from the store,
 * kept in sync by `useMeetingWiring` at the root.
 */
export const useMeeting = (): {
  current: Meeting | null;
  open: () => Promise<Meeting | null>;
  end: () => Promise<void>;
} => {
  const current = useAppStore((s) => s.currentMeeting);
  const setCurrent = useAppStore((s) => s.setCurrentMeeting);
  const mySpokenLanguage = useAppStore((s) => s.preferences.mySpokenLanguage);
  const meetingLanguage = useAppStore((s) => s.preferences.meetingLanguage);

  const open = useCallback(async (): Promise<Meeting | null> => {
    try {
      // engineId is resolved authoritatively in main via getActiveEngineId()
      // — do not send it from here, prefs may diverge from runtime in
      // packaged builds.
      const result = await window.babelVoiceBridge.openMeeting({
        langSrc: mySpokenLanguage,
        langTgt: meetingLanguage
      });
      setCurrent(result.meeting);
      return result.meeting;
    } catch (err) {
      console.error('openMeeting failed', err);
      return null;
    }
  }, [mySpokenLanguage, meetingLanguage, setCurrent]);

  const end = useCallback(async (): Promise<void> => {
    try {
      await window.babelVoiceBridge.endMeeting();
    } finally {
      setCurrent(null);
    }
  }, [setCurrent]);

  return { current, open, end };
};
