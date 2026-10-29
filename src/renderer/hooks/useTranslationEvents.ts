import { useEffect } from 'react';
import type { Direction } from '@shared/ipc-types.js';
import { useAppStore } from '../store/app-store.js';

/**
 * Subscribe to *all* translation events and status broadcasts coming from
 * main, feeding them into the store. Engines also consume the events via
 * their own subscriptions; the store copy drives the subtitles, transcript
 * and the session lifecycle reflected in the controls.
 *
 * Status comes only from the IPC.TranslationStatus channel — main is
 * authoritative (see ADR-0001). Renderer hooks no longer invent transitions.
 */
export const useTranslationEvents = (): void => {
  const push = useAppStore((s) => s.pushEvent);
  const setSessionStatus = useAppStore((s) => s.setSessionStatus);
  useEffect(() => {
    let disposed = false;
    const broadcastSeen = new Set<Direction>();
    const unsubEvent = window.babelVoiceBridge.onTranslationEvent((event) => {
      push(event);
    });
    const unsubStatus = window.babelVoiceBridge.onTranslationStatus(
      ({ direction, status, errorMessage, errorKind }) => {
        broadcastSeen.add(direction);
        setSessionStatus(direction, status, errorMessage ?? null, errorKind ?? null);
      }
    );
    // A window (re)loaded mid-session would otherwise show idle while main
    // has a running session. Pull a snapshot once; a broadcast that lands
    // first is newer, so it wins for that direction.
    void window.babelVoiceBridge
      .getTranslationStatuses()
      .then((statuses) => {
        if (disposed) return;
        for (const { direction, status } of statuses) {
          if (broadcastSeen.has(direction)) continue;
          if (useAppStore.getState()[direction].status !== status) {
            setSessionStatus(direction, status, null);
          }
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unsubEvent();
      unsubStatus();
    };
  }, [push, setSessionStatus]);
};
