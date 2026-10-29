/**
 * DashScope (阿里百炼) credentials for the Qwen3.8 LiveTranslate realtime model.
 *
 * Plaintext shape lives here (not in shared/) — credentials never appear in
 * shared types. Per-user values are entered via Settings, encrypted at rest
 * by `credential-vault.ts`, and read by `QwenClient.start()` via
 * `getQwenCredentials()`. See ADR-0002 amendment.
 */
export interface QwenCredentials {
  apiKey: string;
  /**
   * 百炼业务空间 ID (e.g. `llm-xxx`). When set, QwenClient connects to the
   * workspace-dedicated host `{workspaceId}.cn-beijing.maas.aliyuncs.com`
   * (what the qwen3.8 docs prescribe); otherwise to the legacy shared
   * `dashscope.aliyuncs.com`. Not a secret, so it's shown back in Settings.
   */
  workspaceId?: string;
}
