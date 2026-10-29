/**
 * Volcengine LiveInterpret 2.0 (豆包同传) credentials.
 *
 * Plaintext shape lives here (not in shared/) — credentials never appear in
 * shared types. Per-user `appKey` + `accessKey` are entered via Settings,
 * encrypted at rest by `credential-vault.ts`, and read by
 * `DoubaoClient.start()` via `getDoubaoCredentials()`. `resourceId` is
 * the LiveInterpret service-type identifier and is the same for every
 * user; the vault fills it in when constructing the credential record.
 * See ADR-0002 amendment.
 */
export interface DoubaoCredentials {
  appKey: string;
  accessKey: string;
  resourceId: string;
}
