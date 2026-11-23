import type { CredentialedEngineId } from '@shared/engine-types.js';
import type { SetCredentialsPayload } from '@shared/ipc-types.js';

/**
 * Which fields each provider's credentials take, and how a draft of them
 * becomes the `credentials:set` payload. Single source for every surface
 * that edits keys (Settings → 翻译服务, the onboarding engine step); each
 * surface only supplies its own copy. Framework-free so the rules are
 * unit-testable; `<CredentialForm>` renders them.
 */

export type CredentialFieldName = 'appKey' | 'accessKey' | 'apiKey' | 'workspaceId';

export interface CredentialField {
  name: CredentialFieldName;
  /** Rendered as a password input. */
  secret: boolean;
  /** Not needed to save (Qwen's 业务空间 ID; Doubao's either-or fields). */
  optional?: boolean;
}

export const CREDENTIAL_FIELDS: Record<CredentialedEngineId, readonly CredentialField[]> = {
  // New-console API Key, or the old console's App Key + Access Key pair.
  doubao: [
    { name: 'apiKey', secret: true, optional: true },
    { name: 'appKey', secret: false, optional: true },
    { name: 'accessKey', secret: true, optional: true }
  ],
  qwen: [
    { name: 'apiKey', secret: true },
    { name: 'workspaceId', secret: false, optional: true }
  ],
  gemini: [{ name: 'apiKey', secret: true }],
  openai: [{ name: 'apiKey', secret: true }]
};

/** Raw (untrimmed) input values, keyed by field. */
export type CredentialDraft = Partial<Record<CredentialFieldName, string>>;

const field = (draft: CredentialDraft, name: CredentialFieldName): string =>
  (draft[name] ?? '').trim();

/** Every required field has a non-blank value. */
export const isCredentialDraftComplete = (
  engineId: CredentialedEngineId,
  draft: CredentialDraft
): boolean => {
  if (engineId === 'doubao') {
    return (
      field(draft, 'apiKey').length > 0 ||
      (field(draft, 'appKey').length > 0 && field(draft, 'accessKey').length > 0)
    );
  }
  return CREDENTIAL_FIELDS[engineId].every((f) => f.optional || field(draft, f.name).length > 0);
};

/** Trimmed payload; a blank optional field is sent as absent. */
export const toCredentialsPayload = (
  engineId: CredentialedEngineId,
  draft: CredentialDraft
): SetCredentialsPayload => {
  switch (engineId) {
    case 'doubao':
      // An API Key wins: it's the new console's whole credential.
      return field(draft, 'apiKey')
        ? { engineId, apiKey: field(draft, 'apiKey') }
        : {
            engineId,
            appKey: field(draft, 'appKey'),
            accessKey: field(draft, 'accessKey')
          };
    case 'qwen':
      return {
        engineId,
        apiKey: field(draft, 'apiKey'),
        workspaceId: field(draft, 'workspaceId') || undefined
      };
    case 'gemini':
    case 'openai':
      return { engineId, apiKey: field(draft, 'apiKey') };
  }
};
