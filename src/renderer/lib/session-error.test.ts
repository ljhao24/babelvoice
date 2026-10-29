import { describe, expect, it } from 'vitest';
import { describeSessionError, formatSessionError } from './session-error.js';

const t = (key: string, options?: Record<string, unknown>): string =>
  options ? `${key}${JSON.stringify(options)}` : key;

describe('describeSessionError', () => {
  it('replaces a classified error with its copy and keeps the raw detail', () => {
    expect(
      describeSessionError(t, 'auth', 'Qwen handshake rejected (HTTP 401): {…}')
    ).toEqual({
      text: 'errors:sessionKind.auth',
      detail: 'Qwen handshake rejected (HTTP 401): {…}',
      needsSettings: true
    });
    expect(
      describeSessionError(t, 'network', 'ws closed: no reason')
    ).toMatchObject({
      text: 'errors:sessionKind.network',
      needsSettings: false
    });
  });

  it('drops the detail for missing credentials and offers Settings', () => {
    expect(
      describeSessionError(t, 'credentials-missing', 'No credentials for qwen')
    ).toEqual({
      text: 'errors:sessionKind.credentials-missing',
      detail: null,
      needsSettings: true
    });
  });

  it('shows an unclassified message as is (main may have localized it)', () => {
    expect(
      describeSessionError(t, 'unknown', '源语言和目标语言不能相同')
    ).toEqual({
      text: '源语言和目标语言不能相同',
      detail: null,
      needsSettings: false
    });
    expect(describeSessionError(t, undefined, 'boom').text).toBe('boom');
  });

  it('falls back to generic copy when nothing usable came with the failure', () => {
    expect(describeSessionError(t, null, null).text).toBe(
      'errors:sessionKind.unknown'
    );
    expect(describeSessionError(t, 'unknown', 'unknown').text).toBe(
      'errors:sessionKind.unknown'
    );
    expect(describeSessionError(t, 'timeout', '').detail).toBeNull();
  });
});

describe('formatSessionError', () => {
  it('folds the detail into one line only when there is one', () => {
    expect(
      formatSessionError(t, { text: 'a', detail: null, needsSettings: false })
    ).toBe('a');
    expect(
      formatSessionError(t, { text: 'a', detail: 'b', needsSettings: false })
    ).toBe('errors:sessionKind.withDetail{"text":"a","detail":"b"}');
  });
});
