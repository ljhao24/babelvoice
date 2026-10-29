/**
 * OpenAI API credentials for the realtime translation model.
 *
 * Plaintext shape lives here (not in shared/) — credentials never appear in
 * shared types. Per-user values are entered via Settings, encrypted at rest
 * by `credential-vault.ts`, and read by `OpenAiClient.start()` via
 * `getOpenAiCredentials()`. See ADR-0002 amendment.
 */
export interface OpenAiCredentials {
  apiKey: string;
}
