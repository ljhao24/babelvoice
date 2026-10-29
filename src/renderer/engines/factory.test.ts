import { describe, expect, it } from 'vitest';
import {
  EMPTY_CREDENTIAL_STATUS,
  PRODUCTION_ENGINE,
  type CredentialStatus,
  type EngineId
} from '@shared/engine-types.js';
import { getEngine, isEngineCredentialed, resolveEngineId } from './factory.js';

// An engine id from a newer build, cloud-synced onto this one.
const future = 'deepl' as unknown as EngineId;

describe('renderer engine catalog', () => {
  it('falls back to the default engine for an unknown id instead of throwing', () => {
    expect(resolveEngineId(future)).toBe(PRODUCTION_ENGINE);
    expect(getEngine(future).id).toBe(PRODUCTION_ENGINE);
    expect(getEngine(future).nameKey).toBe(`engineNames.${PRODUCTION_ENGINE}`);
    expect(resolveEngineId('toString')).toBe(PRODUCTION_ENGINE);
  });

  it('resolves every known engine to itself with an i18n name key', () => {
    for (const id of ['doubao', 'qwen', 'gemini', 'openai', 'mock'] as const) {
      expect(getEngine(id).id).toBe(id);
      expect(getEngine(id).nameKey).toBe(`engineNames.${id}`);
    }
  });

  it('reads credential status null-safely', () => {
    const status = {
      ...EMPTY_CREDENTIAL_STATUS,
      doubao: { configured: true }
    } as CredentialStatus;
    expect(isEngineCredentialed(status, 'doubao')).toBe(true);
    expect(isEngineCredentialed(status, 'mock')).toBe(true);
    // Unknown id resolves to the (configured) default engine.
    expect(isEngineCredentialed(status, future)).toBe(true);
    // A status object missing an engine's slot reads as not configured.
    const partial = { doubao: { configured: false } } as unknown as CredentialStatus;
    expect(isEngineCredentialed(partial, 'openai')).toBe(false);
  });
});
