/**
 * Volcengine LiveInterpret 2.0 (豆包同传) credentials.
 *
 * Two auth styles: the new 豆包语音 console issues a single `apiKey`
 * (sent as `X-Api-Key`); the old console issues `appKey` (APP ID) +
 * `accessKey` (Access Token). A record carries one or the other.
 *
 * Plaintext shape lives here (not in shared/) — credentials never appear in
 * shared types. Per-user `appKey` + `accessKey` are entered via Settings,
 * encrypted at rest by `credential-vault.ts`, and read by
 * `DoubaoClient.start()` via `getDoubaoCredentials()`. `resourceId` is
 * the LiveInterpret service-type identifier and is the same for every
 * user; the vault fills it in when constructing the credential record.
 * See ADR-0002 amendment.
 */
export type DoubaoCredentials =
  | { apiKey: string; appKey?: undefined; accessKey?: undefined; resourceId: string }
  | { apiKey?: undefined; appKey: string; accessKey: string; resourceId: string };

/** The WS upgrade auth headers for either credential style. */
export const doubaoAuthHeaders = (c: DoubaoCredentials): Record<string, string> =>
  c.apiKey
    ? { 'X-Api-Key': c.apiKey, 'X-Api-Resource-Id': c.resourceId }
    : {
        'X-Api-App-Key': c.appKey!,
        'X-Api-Access-Key': c.accessKey!,
        'X-Api-Resource-Id': c.resourceId
      };
