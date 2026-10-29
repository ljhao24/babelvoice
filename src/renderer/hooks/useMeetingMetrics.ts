import { useEffect } from 'react';
import type { MeetingMetricsSnapshot } from '@shared/meeting-metrics-types.js';
import { useAppStore } from '../store/app-store.js';

/**
 * Mirrors main's MeetingMonitor snapshot (link health, usage, cost of the
 * open meeting) into the store. Main pushes at most once a second while a
 * meeting runs; mounted once at the control-panel root (`useRendererWiring`).
 */
export function useMeetingMetricsWiring(): void {
  const apply = useAppStore((s) => s.applyMeetingMetrics);

  useEffect(() => {
    let alive = true;
    let pushed = false;
    const unsub = window.babelVoiceBridge.onMeetingMetrics((snapshot) => {
      pushed = true;
      apply(snapshot);
    });
    // A push that lands first is newer than this pull.
    void window.babelVoiceBridge.getMeetingMetrics().then((snapshot) => {
      if (alive && !pushed) apply(snapshot);
    });
    return () => {
      alive = false;
      unsub();
    };
  }, [apply]);
}

/** The open meeting's monitor snapshot; null outside a meeting. */
export const useMeetingMetrics = (): MeetingMetricsSnapshot | null =>
  useAppStore((s) => s.meetingMetrics);
