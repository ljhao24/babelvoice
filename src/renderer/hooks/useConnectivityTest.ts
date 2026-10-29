import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ValidateCredentialsPayload,
  ValidateCredentialsResult
} from '@shared/ipc-types.js';
import { describeSessionError, formatSessionError } from '../lib/session-error.js';

export type ConnectivityState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ok' }
  | { kind: 'failed'; code?: number; message: string };

/**
 * Onboarding-time wrapper around the `credentials:validate` IPC. Every `run`
 * and `reset` bumps a request sequence; a result only lands if it belongs to
 * the latest request. So switching engines (the caller resets) while a test
 * is in flight can't let the old engine's "ok" enable "next" for an engine
 * that was never tested.
 */
export const useConnectivityTest = (): {
  state: ConnectivityState;
  run: (engineId: ValidateCredentialsPayload['engineId']) => Promise<void>;
  reset: () => void;
} => {
  const { t } = useTranslation('connectivity');
  const [state, setState] = useState<ConnectivityState>({ kind: 'idle' });
  const seqRef = useRef(0);

  const run = useCallback(
    async (engineId: ValidateCredentialsPayload['engineId']): Promise<void> => {
      const seq = ++seqRef.current;
      setState({ kind: 'running' });
      let result: ValidateCredentialsResult;
      try {
        result = await window.babelVoiceBridge.validateCredentials({ engineId });
      } catch (err) {
        if (seq !== seqRef.current) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: 'failed', message });
        return;
      }
      if (seq !== seqRef.current) return;
      if (result.ok) {
        setState({ kind: 'ok' });
      } else {
        // A classified failure reads as its kind's copy, with the
        // provider's raw message kept as the detail; the rest stay raw.
        // Missing credentials keep main's message: it names the key, and
        // the user is already where they enter it.
        setState({
          kind: 'failed',
          code: result.code,
          message:
            result.errorKind && result.errorKind !== 'credentials-missing'
              ? formatSessionError(
                  t,
                  describeSessionError(t, result.errorKind, result.message)
                )
              : (result.message ?? t('fallbackError'))
        });
      }
    },
    [t]
  );

  const reset = useCallback(() => {
    seqRef.current += 1;
    setState({ kind: 'idle' });
  }, []);

  return { state, run, reset };
};
