import { useEffect } from 'react';
import {
  EMPTY_CREDENTIAL_STATUS,
  type CredentialStatus
} from '@shared/engine-types.js';
import type {
  ClearCredentialsPayload,
  SetCredentialsPayload
} from '@shared/ipc-types.js';
import { useAppStore } from '../store/app-store.js';

/**
 * Wires the store's credential status to main: fetch once, then follow
 * `credentials:changed` so multiple windows stay in sync. Mounted once at
 * the control-panel root (see `useRendererWiring`).
 */
export function useCredentialStatusWiring(): void {
  const apply = useAppStore((s) => s.applyCredentialStatus);

  useEffect(() => {
    let cancelled = false;
    void window.babelVoiceBridge
      .getCredentialStatus()
      .then((s) => {
        if (!cancelled) apply(s);
      })
      .catch(() => {
        // Still mark it loaded so the banner / gates can settle; a broadcast
        // that already landed is newer than "nothing configured".
        if (!cancelled && !useAppStore.getState().credentialStatusLoaded) {
          apply(EMPTY_CREDENTIAL_STATUS);
        }
      });
    const unsub = window.babelVoiceBridge.onCredentialsChanged((s) => apply(s));
    return () => {
      cancelled = true;
      unsub();
    };
  }, [apply]);
}

const saveCredentials = async (payload: SetCredentialsPayload): Promise<void> => {
  const next = await window.babelVoiceBridge.setCredentials(payload);
  useAppStore.getState().applyCredentialStatus(next);
};

const clearCredentials = async (
  payload: ClearCredentialsPayload
): Promise<void> => {
  const next = await window.babelVoiceBridge.clearCredentials(payload);
  useAppStore.getState().applyCredentialStatus(next);
};

/**
 * Read-mostly view of which engines have credentials configured. The
 * plaintext keys never reach the renderer; only `configured` flags + the
 * last 4 chars of the primary key (for visual confirmation) come back.
 * State comes from the store, kept in sync by `useCredentialStatusWiring`.
 */
export const useCredentialStatus = (): {
  status: CredentialStatus;
  loaded: boolean;
  save: (payload: SetCredentialsPayload) => Promise<void>;
  clear: (payload: ClearCredentialsPayload) => Promise<void>;
} => {
  const status = useAppStore((s) => s.credentialStatus);
  const loaded = useAppStore((s) => s.credentialStatusLoaded);
  return { status, loaded, save: saveCredentials, clear: clearCredentials };
};
