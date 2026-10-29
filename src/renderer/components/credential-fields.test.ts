import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_FIELDS,
  isCredentialDraftComplete,
  toCredentialsPayload
} from './credential-fields.js';

describe('CREDENTIAL_FIELDS', () => {
  it('masks the secrets and leaves identifiers readable', () => {
    const masked = (id: keyof typeof CREDENTIAL_FIELDS) =>
      CREDENTIAL_FIELDS[id].map((f) => [f.name, f.secret]);
    expect(masked('doubao')).toEqual([
      ['appKey', false],
      ['accessKey', true]
    ]);
    expect(masked('qwen')).toEqual([
      ['apiKey', true],
      ['workspaceId', false]
    ]);
    expect(masked('gemini')).toEqual([['apiKey', true]]);
    expect(masked('openai')).toEqual([['apiKey', true]]);
  });
});

describe('isCredentialDraftComplete', () => {
  it('needs both Doubao keys', () => {
    expect(isCredentialDraftComplete('doubao', { appKey: 'a' })).toBe(false);
    expect(isCredentialDraftComplete('doubao', { appKey: 'a', accessKey: '  ' })).toBe(false);
    expect(isCredentialDraftComplete('doubao', { appKey: 'a', accessKey: 'b' })).toBe(true);
  });

  it('treats the Qwen workspace as optional', () => {
    expect(isCredentialDraftComplete('qwen', { workspaceId: 'llm-1' })).toBe(false);
    expect(isCredentialDraftComplete('qwen', { apiKey: 'sk-1' })).toBe(true);
  });

  it('ignores fields another engine uses', () => {
    expect(isCredentialDraftComplete('gemini', { appKey: 'a', accessKey: 'b' })).toBe(false);
    expect(isCredentialDraftComplete('openai', { apiKey: ' sk ' })).toBe(true);
  });
});

describe('toCredentialsPayload', () => {
  it('trims every value', () => {
    expect(toCredentialsPayload('doubao', { appKey: ' a ', accessKey: '\tb\n' })).toEqual({
      engineId: 'doubao',
      appKey: 'a',
      accessKey: 'b'
    });
    expect(toCredentialsPayload('openai', { apiKey: ' sk-1 ' })).toEqual({
      engineId: 'openai',
      apiKey: 'sk-1'
    });
  });

  it('sends a blank Qwen workspace as absent', () => {
    expect(toCredentialsPayload('qwen', { apiKey: 'sk-1', workspaceId: '  ' })).toEqual({
      engineId: 'qwen',
      apiKey: 'sk-1',
      workspaceId: undefined
    });
    expect(toCredentialsPayload('qwen', { apiKey: 'sk-1', workspaceId: ' llm-2 ' })).toEqual({
      engineId: 'qwen',
      apiKey: 'sk-1',
      workspaceId: 'llm-2'
    });
  });

  it('drops fields the engine does not take', () => {
    expect(
      toCredentialsPayload('gemini', { apiKey: 'AIza', workspaceId: 'llm-2', appKey: 'x' })
    ).toEqual({ engineId: 'gemini', apiKey: 'AIza' });
  });
});
