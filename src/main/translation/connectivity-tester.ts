/**
 * Onboarding-time credential smoke test.
 *
 * Constructs a real TranslationClient via `createTranslationClient`,
 * `start()`s it just far enough to know the provider accepted us
 * ("session-started"), then immediately `cancel()`s. No PCM frames are
 * ever sent — Doubao and OpenAI bill per audio second/minute, Qwen and
 * Gemini per audio token, so a connect-and-bail produces zero billable
 * usage.
 *
 * Maps every failure mode (rejected start, server-emitted session-failed,
 * 6-second hang, missing creds) into the same `ValidateCredentialsResult`
 * shape so the renderer can render a single error path.
 */
import type { ValidateCredentialsResult } from '@shared/ipc-types.js';
import type { CredentialedEngineId } from '@shared/engine-types.js';
import { getPreferences } from '../config-store.js';
import { createTranslationClient } from './client-factory.js';
import { buildClientStartParams } from './engine-selection.js';
import {
  getDoubaoCredentials,
  getGeminiCredentials,
  getOpenAiCredentials,
  getQwenCredentials
} from './credential-vault.js';
import type { TranslationEventBody } from './translation-client.js';
import { errorKindOf } from './translation-error.js';
import type { TranslationErrorKind } from '@shared/translation-error-types.js';
import { log } from '@core/utils/logger.js';
import { t } from '../i18n.js';

const TIMEOUT_MS = 6000;
/**
 * Gemini and OpenAI go through the user's proxy to an overseas endpoint,
 * and their setup handshake is a full model-session allocation — routinely
 * slower than the domestic providers' plain WS upgrade.
 */
const OVERSEAS_TIMEOUT_MS = 12_000;

export const validateCredentials = async (
  engineId: CredentialedEngineId
): Promise<ValidateCredentialsResult> => {
  // Bail before constructing a client if the vault has nothing — saves a
  // round-trip and gives a kinder message than the upstream error string.
  const missing = (message: string): ValidateCredentialsResult => ({
    ok: false,
    message,
    errorKind: 'credentials-missing'
  });
  if (engineId === 'doubao' && !getDoubaoCredentials()) {
    return missing(t('connectivity:missingDoubaoKey'));
  }
  if (engineId === 'qwen' && !getQwenCredentials()) {
    return missing(t('connectivity:missingQwenKey'));
  }
  if (engineId === 'gemini' && !getGeminiCredentials()) {
    return missing(t('connectivity:missingGeminiKey'));
  }
  if (engineId === 'openai' && !getOpenAiCredentials()) {
    return missing(t('connectivity:missingOpenAiKey'));
  }

  const prefs = getPreferences();
  // Use a minimal valid pair (zh→en) regardless of the user's saved
  // language setting — the goal is "can we talk to the server", not
  // "do these languages translate".
  const params = buildClientStartParams(
    {
      direction: 'speak',
      sourceLanguage: 'zh',
      targetLanguage: 'en',
      mode: 's2t'
    },
    engineId
  );

  // Capture the most recent server-emitted failure event so we can surface
  // a useful code/message even if start() rejects with a generic Error.
  // Stored in a holder object because TS narrowing inside the catch block
  // would otherwise infer the variable as `never` based on its initial
  // value and ignore the closure mutation.
  const failure: {
    value: { code?: number; message: string; kind: TranslationErrorKind } | null;
  } = {
    value: null
  };
  const onEvent = (event: TranslationEventBody): void => {
    if (event.type === 'session-failed') {
      failure.value = { code: event.code, message: event.message, kind: event.kind };
    }
  };

  const client = createTranslationClient(engineId, {
    onEvent,
    tag: 'validate'
  });

  let timer: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      client.start(params),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('connect_timeout')),
          engineId === 'gemini' || engineId === 'openai'
            ? OVERSEAS_TIMEOUT_MS
            : TIMEOUT_MS
        );
      })
    ]);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`validateCredentials(${engineId}) failed: ${message}`);
    if (failure.value) {
      return {
        ok: false,
        code: failure.value.code,
        message: failure.value.message,
        errorKind: failure.value.kind
      };
    }
    if (message === 'connect_timeout') {
      // Already specific, localized copy: no kind for the renderer to swap in.
      return { ok: false, message: t('connectivity:connectTimeout') };
    }
    return { ok: false, message, errorKind: errorKindOf(err) };
  } finally {
    if (timer !== null) clearTimeout(timer);
    // cancel() is idempotent and safe whether start resolved or rejected.
    await client.cancel().catch(() => undefined);
  }
};
