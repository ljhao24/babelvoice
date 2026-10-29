/**
 * Per-user credential storage. Keys are entered by the user in Settings,
 * encrypted at rest with Electron's `safeStorage` (Keychain on macOS),
 * and persisted as opaque base64 alongside `preferences` in
 * `electron-store`.
 *
 * ADR-0002 amendment: plaintext credentials cross IPC only renderer→main
 * on save (never main→renderer). Reads expose only a `CredentialStatus`
 * (presence flags + last-4-char tail). Each TranslationClient still
 * self-imports its credentials at the top of `start()` — the import
 * target moved from a static const to `get*Credentials()` here.
 */
import Store from 'electron-store';
import { safeStorage } from 'electron';
import type { CredentialStatus } from '@shared/engine-types.js';
import type { PersistedConfig } from '@shared/config-types.js';
import { log } from '@core/utils/logger.js';
import type { DoubaoCredentials } from './doubao-credentials.js';
import type { QwenCredentials } from './qwen-credentials.js';
import type { GeminiCredentials } from './gemini-credentials.js';
import type { OpenAiCredentials } from './openai-credentials.js';

const store = new Store<PersistedConfig>({ name: 'babelvoice' });

// A TranslationError ('credentials-missing') now; re-exported so existing
// imports from the vault keep working.
export { MissingCredentialsError } from './translation-error.js';

interface CredentialCache {
  doubao: DoubaoCredentials | null;
  qwen: QwenCredentials | null;
  gemini: GeminiCredentials | null;
  openai: OpenAiCredentials | null;
}
type Slot = keyof CredentialCache;

/**
 * Per-slot memo of what is on disk. A slot is filled once its blob was read
 * — or found absent or malformed, which re-reading can't fix. A blob that
 * couldn't be *decrypted* stays unfilled and is retried on the next read:
 * the cause may be transient (keyring not up yet, Keychain locked), and
 * memoizing it would show the engine as "not configured" for the rest of
 * the run.
 */
const cache: Partial<CredentialCache> = {};
let warnedNoEncryption = false;
const warnedUnreadable = new Set<Slot>();

const tail = (s: string): string => s.slice(-4);

const RESOURCE_ID = 'volc.service_type.10053';

/** Prefix of a blob saved while safeStorage was unavailable. */
const PLAIN_PREFIX = 'plain:';

const encryptionAvailable = (): boolean => {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
};

const encrypt = (plaintext: string): string => {
  if (encryptionAvailable()) {
    return safeStorage.encryptString(plaintext).toString('base64');
  }
  if (!warnedNoEncryption) {
    log.warn(
      'safeStorage unavailable — credentials will be stored as base64 plaintext. ' +
        'Sign the app or run on a desktop with a working keyring for at-rest encryption.'
    );
    warnedNoEncryption = true;
  }
  return `${PLAIN_PREFIX}${Buffer.from(plaintext, 'utf8').toString('base64')}`;
};

/** A stored blob that can't be decrypted right now. */
const UNREADABLE = Symbol('unreadable');

const decrypt = (blob: string, slot: Slot): string | typeof UNREADABLE => {
  if (blob.startsWith(PLAIN_PREFIX)) {
    return Buffer.from(blob.slice(PLAIN_PREFIX.length), 'base64').toString('utf8');
  }
  try {
    if (!encryptionAvailable()) throw new Error('safeStorage unavailable');
    return safeStorage.decryptString(Buffer.from(blob, 'base64'));
  } catch (err) {
    if (!warnedUnreadable.has(slot)) {
      warnedUnreadable.add(slot);
      log.warn(
        `${slot} credentials can't be decrypted (keychain unavailable, corrupt, or a different keychain); retrying on next use:`,
        err
      );
    }
    return UNREADABLE;
  }
};

const persist = (
  patch: Partial<NonNullable<PersistedConfig['credentials']>>
): void => {
  const current = store.get('credentials') ?? {};
  const next = { ...current, ...patch };
  // Drop keys whose value is undefined so the on-disk JSON stays clean.
  for (const k of Object.keys(next) as (keyof typeof next)[]) {
    if (next[k] === undefined) delete next[k];
  }
  if (Object.keys(next).length === 0) {
    (store as unknown as { delete: (k: string) => void }).delete('credentials');
  } else {
    store.set('credentials', next);
  }
};

const apiKeyOf = (json: Record<string, unknown>): { apiKey: string } | null =>
  typeof json.apiKey === 'string' && json.apiKey ? { apiKey: json.apiKey } : null;

/** Parsed JSON blob → credential record; null if a required field is missing. */
const PARSERS: {
  [K in Slot]: (json: Record<string, unknown>) => CredentialCache[K];
} = {
  doubao: (json) => {
    const parsed = json as Partial<DoubaoCredentials>;
    return parsed.appKey && parsed.accessKey
      ? {
          appKey: parsed.appKey,
          accessKey: parsed.accessKey,
          resourceId: parsed.resourceId || RESOURCE_ID
        }
      : null;
  },
  // Qwen's blob is `{ apiKey }` plus an optional workspace ID.
  qwen: (json) => {
    const parsed = json as Partial<QwenCredentials>;
    if (!parsed.apiKey) return null;
    return parsed.workspaceId
      ? { apiKey: parsed.apiKey, workspaceId: parsed.workspaceId }
      : { apiKey: parsed.apiKey };
  },
  gemini: apiKeyOf,
  openai: apiKeyOf
};

/**
 * A `plain:` blob was saved while safeStorage was unavailable. Now that it
 * works, re-encrypt it in place; if that fails the plain copy stays and the
 * next launch tries again.
 */
const migratePlainBlob = (slot: Slot, plaintext: string): void => {
  try {
    persist({ [slot]: safeStorage.encryptString(plaintext).toString('base64') });
    log.info(`${slot} credentials migrated from plaintext to safeStorage`);
  } catch (err) {
    log.warn(`${slot} credentials re-encryption failed; keeping the plaintext copy:`, err);
  }
};

const load = <K extends Slot>(slot: K): CredentialCache[K] => {
  if (slot in cache) return cache[slot] as CredentialCache[K];
  const blob = store.get('credentials')?.[slot];
  if (!blob) {
    cache[slot] = null;
    return null;
  }
  const plain = decrypt(blob, slot);
  if (plain === UNREADABLE) return null; // not memoized: retried next read
  let value: CredentialCache[K] = null;
  try {
    value = PARSERS[slot](JSON.parse(plain) as Record<string, unknown>);
  } catch (err) {
    log.warn(`${slot} credentials JSON malformed:`, err);
  }
  cache[slot] = value;
  warnedUnreadable.delete(slot);
  if (value && blob.startsWith(PLAIN_PREFIX) && encryptionAvailable()) {
    migratePlainBlob(slot, plain);
  }
  return value;
};

export const getDoubaoCredentials = (): DoubaoCredentials | null =>
  load('doubao');

export const getQwenCredentials = (): QwenCredentials | null => load('qwen');

export const getGeminiCredentials = (): GeminiCredentials | null =>
  load('gemini');

export const getOpenAiCredentials = (): OpenAiCredentials | null =>
  load('openai');

export const setDoubaoCredentials = (
  c: { appKey: string; accessKey: string } | null
): void => {
  if (c === null) {
    cache.doubao = null;
    persist({ doubao: undefined });
    return;
  }
  const full: DoubaoCredentials = {
    appKey: c.appKey,
    accessKey: c.accessKey,
    resourceId: RESOURCE_ID
  };
  cache.doubao = full;
  persist({ doubao: encrypt(JSON.stringify(full)) });
};

export const setQwenCredentials = (c: QwenCredentials | null): void => {
  if (c === null) {
    cache.qwen = null;
    persist({ qwen: undefined });
    return;
  }
  const full: QwenCredentials = c.workspaceId
    ? { apiKey: c.apiKey, workspaceId: c.workspaceId }
    : { apiKey: c.apiKey };
  cache.qwen = full;
  persist({ qwen: encrypt(JSON.stringify(full)) });
};

export const setGeminiCredentials = (c: { apiKey: string } | null): void => {
  if (c === null) {
    cache.gemini = null;
    persist({ gemini: undefined });
    return;
  }
  cache.gemini = { apiKey: c.apiKey };
  persist({ gemini: encrypt(JSON.stringify(cache.gemini)) });
};

export const setOpenAiCredentials = (c: { apiKey: string } | null): void => {
  if (c === null) {
    cache.openai = null;
    persist({ openai: undefined });
    return;
  }
  cache.openai = { apiKey: c.apiKey };
  persist({ openai: encrypt(JSON.stringify(cache.openai)) });
};

export const getCredentialStatus = (): CredentialStatus => {
  const cur: CredentialCache = {
    doubao: load('doubao'),
    qwen: load('qwen'),
    gemini: load('gemini'),
    openai: load('openai')
  };
  return {
    doubao: cur.doubao
      ? { configured: true, appKeyTail: tail(cur.doubao.appKey) }
      : { configured: false },
    qwen: cur.qwen
      ? {
          configured: true,
          apiKeyTail: tail(cur.qwen.apiKey),
          ...(cur.qwen.workspaceId ? { workspaceId: cur.qwen.workspaceId } : {})
        }
      : { configured: false },
    gemini: cur.gemini
      ? { configured: true, apiKeyTail: tail(cur.gemini.apiKey) }
      : { configured: false },
    openai: cur.openai
      ? { configured: true, apiKeyTail: tail(cur.openai.apiKey) }
      : { configured: false }
  };
};
