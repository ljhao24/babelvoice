/**
 * Renderer-side engine display catalog. The runtime selection lives in
 * main (`src/main/translation/client-factory.ts`); the renderer only
 * needs the EngineId union (re-exported from shared), the i18n key for
 * each engine's user-facing name, and the TTS rate for local monitoring.
 */
import {
  PRODUCTION_ENGINE,
  isEngineId,
  type CredentialStatus,
  type EngineId
} from '@shared/engine-types.js';

export type { EngineId };

export interface EngineDescriptor {
  readonly id: EngineId;
  /** Key in the `languages` namespace for the engine's display name. */
  readonly nameKey: `engineNames.${EngineId}`;
}

const engines: Record<EngineId, EngineDescriptor> = {
  doubao: { id: 'doubao', nameKey: 'engineNames.doubao' },
  qwen: { id: 'qwen', nameKey: 'engineNames.qwen' },
  gemini: { id: 'gemini', nameKey: 'engineNames.gemini' },
  openai: { id: 'openai', nameKey: 'engineNames.openai' },
  mock: { id: 'mock', nameKey: 'engineNames.mock' }
};

/**
 * `prefs.engineId` can hold an engine this build doesn't ship (cloud-synced
 * from a newer install). Display-side lookups fall back to the default
 * engine instead of throwing during render; main stays authoritative for
 * which engine actually runs (ADR-0002).
 */
export const resolveEngineId = (id: unknown): EngineId =>
  isEngineId(id) ? id : PRODUCTION_ENGINE;

export const getEngine = (id: EngineId): EngineDescriptor =>
  engines[resolveEngineId(id)];

/**
 * Null-safe "does the shown engine have credentials" — `status[id]` is
 * undefined for an id main didn't report.
 */
export const isEngineCredentialed = (
  status: CredentialStatus,
  id: EngineId
): boolean => {
  const resolved = resolveEngineId(id);
  if (resolved === 'mock') return true;
  return status[resolved]?.configured ?? false;
};
