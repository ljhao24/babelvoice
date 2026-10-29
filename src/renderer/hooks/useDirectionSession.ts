import { useCallback, useMemo } from 'react';
import type {
  Direction,
  StartTranslationParams
} from '../../shared/ipc-types.js';
import { setDirectionTransient, useAppStore } from '../store/app-store.js';

export interface DirectionSessionControls {
  /**
   * Resolves `true` once main reports the session open (running), `false`
   * when it was not started — gated or failed to open. Failure
   * details still arrive via the IPC.TranslationStatus broadcast.
   */
  start: () => Promise<boolean>;
  stop: () => Promise<void>;
  toggle: () => Promise<void>;
}

interface DirectionSessionOptions {
  /**
   * Throwaway session (onboarding probe): its transcript renders live but
   * never lands in the meeting history / DB. See `setDirectionTransient`.
   */
  transient?: boolean;
}

/**
 * Shared lifecycle controls for a DirectionSession (see ADR-0001).
 *
 * Status is owned by the main process and broadcast via IPC.TranslationStatus.
 * This hook is a pure command emitter:
 *   - `start` is gated on idle/failed and dispatches an optimistic 'connecting'
 *   - `stop` routes to finish (running) vs cancel (connecting/finishing)
 *   - `toggle` flips between the two
 *
 * Callers supply `buildStartParams` — the only thing that differs between
 * speak (mic UID, speakerId, mode=s2s, output format) and listen (mode=s2t).
 * Pass a memoized callback so the returned controls keep a stable identity
 * across renders (effects that depend on them won't re-run).
 */
export const useDirectionSession = (
  direction: Direction,
  buildStartParams: () => StartTranslationParams,
  { transient = false }: DirectionSessionOptions = {}
): DirectionSessionControls => {
  const setSessionStatus = useAppStore((s) => s.setSessionStatus);

  const start = useCallback(async (): Promise<boolean> => {
    const state = useAppStore.getState();
    const status = state[direction].status;
    if (status !== 'idle' && status !== 'failed') return false;
    if (transient) setDirectionTransient(direction, true);
    setSessionStatus(direction, 'connecting');
    try {
      await window.babelVoiceBridge.startTranslation(buildStartParams());
      return true;
    } catch (err) {
      // Whatever main is now reporting for this direction isn't ours.
      if (transient) setDirectionTransient(direction, false);
      // Failures settle the UI via IPC.TranslationStatus broadcast;
      // the `false` lets callers skip follow-up work (e.g. sample playback).
      console.warn(`[session] ${direction} start failed`, err);
      return false;
    }
  }, [direction, buildStartParams, setSessionStatus, transient]);

  const stop = useCallback(async (): Promise<void> => {
    const status = useAppStore.getState()[direction].status;
    if (status === 'idle' || status === 'failed' || status === 'cancelling') {
      return;
    }
    try {
      if (status === 'running') {
        await window.babelVoiceBridge.finishTranslation(direction);
      } else {
        // connecting / finishing → force cancel.
        await window.babelVoiceBridge.cancelTranslation(direction);
      }
    } catch {
      // The status broadcast settles the UI either way.
    }
  }, [direction]);

  const toggle = useCallback(async (): Promise<void> => {
    const status = useAppStore.getState()[direction].status;
    if (status === 'idle' || status === 'failed') {
      await start();
    } else {
      await stop();
    }
  }, [direction, start, stop]);

  return useMemo(() => ({ start, stop, toggle }), [start, stop, toggle]);
};
