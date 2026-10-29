import { describe, expect, it, vi } from 'vitest';
import type { EngineId } from '@shared/engine-types.js';

// proto-loader reads `app.isPackaged`; proxy-agent imports `session`; the
// vault pulls in electron-store. None of them is exercised here.
vi.mock('electron', () => ({ app: { isPackaged: false }, session: {} }));
vi.mock('./credential-vault.js', () => ({
  MissingCredentialsError: class MissingCredentialsError extends Error {}
}));

const { createTranslationClient } = await import('./client-factory.js');

describe('createTranslationClient', () => {
  it('mints the client for each known engine', () => {
    for (const id of ['doubao', 'qwen', 'gemini', 'openai', 'mock'] as const) {
      expect(createTranslationClient(id, { onEvent: () => undefined }).engineId).toBe(id);
    }
  });

  it('throws a clear error for an engine this build does not know', () => {
    // e.g. synced from a newer build's prefs.
    expect(() =>
      createTranslationClient('whisper' as EngineId, { onEvent: () => undefined })
    ).toThrow('Unknown translation engine: whisper');
  });
});
