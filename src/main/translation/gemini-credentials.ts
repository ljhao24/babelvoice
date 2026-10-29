/**
 * Google Gemini API credentials for the Live Translate model
 * (`gemini-3.5-live-translate-preview`).
 *
 * Plaintext shape lives here (not in shared/) — credentials never appear in
 * shared types. Per-user values are entered via Settings, encrypted at rest
 * by `credential-vault.ts`, and read by `GeminiClient.start()` via
 * `getGeminiCredentials()`. See ADR-0002 amendment.
 */
export interface GeminiCredentials {
  apiKey: string;
}
