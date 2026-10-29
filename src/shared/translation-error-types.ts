/**
 * Why a translation session failed, as a closed set the renderer can map to
 * user-facing copy. Main classifies (`TranslationError` in
 * src/main/translation/translation-error.ts); the raw technical message
 * travels alongside it for logs and diagnostics only, never as UI text.
 *
 *   auth                 the provider rejected the credentials (HTTP 401/403,
 *                        "invalid API key", …)
 *   quota                out of quota / balance, rate-limited, concurrency cap
 *                        (HTTP 429, "Quota exceeded", 欠费, …)
 *   network              couldn't reach the server, or lost the connection
 *                        (DNS/TCP/TLS/proxy errors, socket drop, keepalive
 *                        silence)
 *   timeout              the server was reachable but didn't answer in time
 *                        (handshake or ready-event deadline)
 *   protocol             the server refused the request itself (bad params,
 *                        unsupported language, WS close 1007/1008, …)
 *   server               the provider failed on its side (HTTP 5xx, WS 1011,
 *                        "server busy")
 *   credentials-missing  no API key configured for the engine
 *   audio-device         local capture or TTS playback failed
 *   unknown              anything else
 */
export type TranslationErrorKind =
  | 'auth'
  | 'quota'
  | 'network'
  | 'timeout'
  | 'protocol'
  | 'server'
  | 'credentials-missing'
  | 'audio-device'
  | 'unknown';

/** Every kind, e.g. for an exhaustive copy table. */
export const TRANSLATION_ERROR_KINDS: readonly TranslationErrorKind[] = [
  'auth',
  'quota',
  'network',
  'timeout',
  'protocol',
  'server',
  'credentials-missing',
  'audio-device',
  'unknown'
];
