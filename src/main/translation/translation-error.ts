/**
 * Typed failures for the translation clients. Every expected failure —
 * handshake rejection, socket error, timeout, provider error frame — is a
 * `TranslationError` carrying a `TranslationErrorKind` (shared with the
 * renderer) next to the raw technical message. The kind is what crosses IPC
 * for the UI to word; the message stays a diagnostic.
 *
 * The classifiers below turn the raw signals (HTTP status of a refused
 * upgrade, WebSocket close code, provider error code/text) into a kind.
 * Structured signals win; free-text hints only refine the ambiguous ones
 * (Gemini closes with 1008 for both "API key not valid" and "Quota
 * exceeded").
 */
import type { EngineId } from '@shared/engine-types.js';
import type { TranslationErrorKind } from '@shared/translation-error-types.js';
import type { TranslationEventBody } from './translation-client.js';

export interface TranslationErrorDetails {
  provider?: EngineId;
  /** WebSocket close code, when the failure was a close. */
  closeCode?: number;
  /** HTTP status of a refused WebSocket upgrade. */
  httpStatus?: number;
  /** The provider's own code: Doubao status code, DashScope / OpenAI error code. */
  providerCode?: string | number;
  cause?: unknown;
}

export class TranslationError extends Error {
  readonly kind: TranslationErrorKind;
  readonly provider?: EngineId;
  readonly closeCode?: number;
  readonly httpStatus?: number;
  readonly providerCode?: string | number;

  constructor(
    kind: TranslationErrorKind,
    message: string,
    details: TranslationErrorDetails = {}
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'TranslationError';
    this.kind = kind;
    this.provider = details.provider;
    this.closeCode = details.closeCode;
    this.httpStatus = details.httpStatus;
    this.providerCode = details.providerCode;
  }

  /**
   * The numeric diagnostic a `session-failed` carries: the provider's code
   * when it is numeric (Doubao status codes), else the HTTP status, else
   * the close code. Undefined when none applies — never a -1 placeholder.
   */
  get code(): number | undefined {
    const pc = this.providerCode;
    if (typeof pc === 'number') return pc;
    if (typeof pc === 'string') {
      const n = Number.parseInt(pc, 10);
      if (Number.isFinite(n)) return n;
    }
    return this.httpStatus ?? this.closeCode;
  }

  /** The most specific code for a log line or message: `code=…`, or ''. */
  get codeLabel(): string {
    const raw = this.providerCode ?? this.httpStatus ?? this.closeCode;
    return raw === undefined || raw === '' ? '' : `code=${raw}`;
  }

  /** Same failure, new message (e.g. prefixed for a start() rejection). */
  withMessage(message: string): TranslationError {
    return new TranslationError(this.kind, message, {
      provider: this.provider,
      closeCode: this.closeCode,
      httpStatus: this.httpStatus,
      providerCode: this.providerCode,
      cause: this.cause
    });
  }
}

/**
 * The engine has no API key configured. Thrown at the top of start(); the
 * renderer surfaces a "前往设置填入 API 密钥" CTA.
 */
export class MissingCredentialsError extends TranslationError {
  readonly engineId: EngineId;
  constructor(engineId: EngineId) {
    super(
      'credentials-missing',
      `missing_credentials: ${engineId} API key is not configured — open Settings → 翻译服务 to enter it`,
      { provider: engineId }
    );
    this.name = 'MissingCredentialsError';
    this.engineId = engineId;
  }
}

/** A thrown value's kind: a TranslationError's own, else `fallback`. */
export const errorKindOf = (
  err: unknown,
  fallback: TranslationErrorKind = 'unknown'
): TranslationErrorKind => (err instanceof TranslationError ? err.kind : fallback);

/** Keep a TranslationError as is; wrap anything else as `kind`. */
export const toTranslationError = (
  err: unknown,
  kind: TranslationErrorKind,
  details: TranslationErrorDetails = {}
): TranslationError => {
  if (err instanceof TranslationError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new TranslationError(kind, message, { ...details, cause: err });
};

/** The `session-failed` body a client emits for `err`. */
export const sessionFailedBody = (
  err: TranslationError,
  message: string = err.message
): Extract<TranslationEventBody, { type: 'session-failed' }> => {
  const code = err.code;
  return code === undefined
    ? { type: 'session-failed', kind: err.kind, message }
    : { type: 'session-failed', kind: err.kind, message, code };
};

// ---------------------------------------------------------------------------
// Classifiers

const QUOTA_HINT =
  /quota|rate[ _-]?limit|limit[ _-]?exceeded|throttl|too many requests|arrearage|insufficient[ _-]?(?:quota|balance|funds|credit)|billing|resource[ _-]?exhausted|欠费|余额|限流|配额|并发/i;
const AUTH_HINT =
  /unauthori[sz]ed|unauthenticated|authenticat|forbidden|permission|access[ _-]?denied|api[ _-]?key|access[ _-]?key|app[ _-]?key|not granted|鉴权|无权限/i;
const TIMEOUT_HINT = /time[ _-]?out|timed out|deadline[ _-]?exceeded|超时/i;
const SERVER_HINT =
  /internal[ _-]?(?:server[ _-]?)?error|service[ _-]?unavailable|unavailable|server[ _-]?(?:error|busy)|overload|繁忙|服务内部/i;

/**
 * What a provider's free text says, if anything. Quota first: an account
 * in arrears is refused with "Access denied…" (DashScope `Arrearage`), and
 * "API key quota exceeded" is still a quota problem.
 */
export const hintedKind = (text: string): TranslationErrorKind | undefined => {
  if (!text) return undefined;
  if (QUOTA_HINT.test(text)) return 'quota';
  if (AUTH_HINT.test(text)) return 'auth';
  if (TIMEOUT_HINT.test(text)) return 'timeout';
  if (SERVER_HINT.test(text)) return 'server';
  return undefined;
};

/** A refused WebSocket upgrade, by HTTP status (and the body it came with). */
export const kindFromHttpStatus = (status: number, body = ''): TranslationErrorKind => {
  if (status === 401) return 'auth';
  if (status === 402 || status === 429) return 'quota';
  if (status >= 400 && status < 500) {
    // A 403 / 400 body often says which it is (DashScope "Arrearage",
    // Volcengine "invalid X-Api-Access-Key").
    const hinted = hintedKind(body);
    if (hinted === 'auth' || hinted === 'quota') return hinted;
    if (status === 403) return 'auth';
    if (status === 407) return 'network'; // the proxy wants credentials
    if (status === 408) return 'timeout';
    return 'protocol';
  }
  if (status >= 500) return 'server';
  return 'unknown';
};

/** A WebSocket closed by the server (or dropped), by close code and reason. */
export const kindFromCloseCode = (code: number, reason = ''): TranslationErrorKind => {
  const hinted = hintedKind(reason);
  if (hinted) return hinted;
  switch (code) {
    case 1003: // unsupported data
    case 1007: // invalid payload (Gemini: bad setup)
    case 1008: // policy violation
    case 1009: // message too big
    case 1010: // missing extension
      return 'protocol';
    case 1011: // internal error
    case 1012: // service restart
    case 1013: // try again later
    case 1014: // bad gateway
      return 'server';
    default:
      // 1000/1001 mid-session, 1005/1006 (no close frame), 1015 (TLS):
      // the connection just went away.
      return code >= 3000 ? 'unknown' : 'network';
  }
};

/**
 * A provider error frame (DashScope / OpenAI `error` event). The structured
 * code is the better signal ("Arrearage", "invalid_api_key"), then an
 * HTTP-like numeric code, then the message text, else `fallback`.
 */
export const kindFromProviderError = (
  code: string | number | undefined,
  message: string,
  fallback: TranslationErrorKind
): TranslationErrorKind => {
  const fromCode = code === undefined ? undefined : hintedKind(String(code));
  if (fromCode) return fromCode;
  const n = typeof code === 'number' ? code : Number.parseInt(code ?? '', 10);
  if (Number.isFinite(n) && n >= 400 && n < 600) return kindFromHttpStatus(n, message);
  return hintedKind(message) ?? fallback;
};
