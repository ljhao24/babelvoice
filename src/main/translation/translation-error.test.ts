import { describe, expect, it } from 'vitest';
import { TRANSLATION_ERROR_KINDS } from '@shared/translation-error-types.js';
import {
  errorKindOf,
  hintedKind,
  kindFromCloseCode,
  kindFromHttpStatus,
  kindFromProviderError,
  MissingCredentialsError,
  sessionFailedBody,
  toTranslationError,
  TranslationError
} from './translation-error.js';

describe('TranslationError', () => {
  it('code: a numeric provider code, else the HTTP status, else the close code — never -1', () => {
    expect(new TranslationError('protocol', 'x', { providerCode: 45_000_001 }).code).toBe(45_000_001);
    expect(new TranslationError('protocol', 'x', { providerCode: '1234' }).code).toBe(1234);
    expect(new TranslationError('auth', 'x', { providerCode: 'InvalidApiKey', httpStatus: 401 }).code).toBe(401);
    expect(new TranslationError('server', 'x', { closeCode: 1011 }).code).toBe(1011);
    expect(new TranslationError('protocol', 'x', { providerCode: 'invalid_request_error' }).code).toBeUndefined();
    expect(new TranslationError('timeout', 'x').code).toBeUndefined();
  });

  it('codeLabel keeps a string provider code for messages', () => {
    expect(new TranslationError('protocol', 'x', { providerCode: 'invalid_value' }).codeLabel).toBe(
      'code=invalid_value'
    );
    expect(new TranslationError('timeout', 'x').codeLabel).toBe('');
  });

  it('withMessage keeps kind and details', () => {
    const cause = new Error('root');
    const err = new TranslationError('quota', 'a', { provider: 'qwen', providerCode: 'Arrearage', cause });
    const re = err.withMessage('b');
    expect(re).toBeInstanceOf(TranslationError);
    expect(re).toMatchObject({ kind: 'quota', message: 'b', provider: 'qwen', providerCode: 'Arrearage' });
    expect(re.cause).toBe(cause);
  });

  it('MissingCredentialsError is a credentials-missing TranslationError', () => {
    const err = new MissingCredentialsError('gemini');
    expect(err).toBeInstanceOf(TranslationError);
    expect(err).toMatchObject({ kind: 'credentials-missing', provider: 'gemini', engineId: 'gemini' });
    expect(err.name).toBe('MissingCredentialsError');
    expect(err.message).toMatch(/^missing_credentials: gemini/);
  });

  it('errorKindOf / toTranslationError keep a TranslationError and classify the rest', () => {
    const typed = new TranslationError('auth', 'denied');
    expect(errorKindOf(typed)).toBe('auth');
    expect(errorKindOf(new Error('x'))).toBe('unknown');
    expect(errorKindOf('x', 'audio-device')).toBe('audio-device');
    expect(toTranslationError(typed, 'network')).toBe(typed);
    expect(toTranslationError(new Error('ECONNRESET'), 'network', { provider: 'openai' })).toMatchObject({
      kind: 'network',
      message: 'ECONNRESET',
      provider: 'openai'
    });
  });

  it('sessionFailedBody omits code when there is none', () => {
    expect(sessionFailedBody(new TranslationError('network', 'lost'))).toEqual({
      type: 'session-failed',
      kind: 'network',
      message: 'lost'
    });
    expect(sessionFailedBody(new TranslationError('server', 'x', { closeCode: 1011 }), 'x (logid=1)')).toEqual({
      type: 'session-failed',
      kind: 'server',
      code: 1011,
      message: 'x (logid=1)'
    });
  });

  it('the shared kind list covers every kind the classifiers produce', () => {
    const produced = new Set([
      kindFromHttpStatus(401),
      kindFromHttpStatus(429),
      kindFromHttpStatus(400),
      kindFromHttpStatus(503),
      kindFromHttpStatus(407),
      kindFromHttpStatus(408),
      kindFromHttpStatus(302),
      kindFromCloseCode(1006),
      kindFromCloseCode(4001)
    ]);
    for (const kind of produced) expect(TRANSLATION_ERROR_KINDS).toContain(kind);
  });
});

describe('classifiers', () => {
  it('HTTP status of a refused upgrade', () => {
    expect(kindFromHttpStatus(401)).toBe('auth');
    expect(kindFromHttpStatus(403)).toBe('auth');
    expect(kindFromHttpStatus(403, 'invalid X-Api-Access-Key')).toBe('auth');
    expect(kindFromHttpStatus(403, '{"code":"Arrearage","message":"Access denied"}')).toBe('quota');
    expect(kindFromHttpStatus(429)).toBe('quota');
    expect(kindFromHttpStatus(402)).toBe('quota');
    expect(kindFromHttpStatus(400, 'quota exceeded for types: concurrency')).toBe('quota');
    expect(kindFromHttpStatus(400, 'bad request')).toBe('protocol');
    expect(kindFromHttpStatus(404)).toBe('protocol');
    expect(kindFromHttpStatus(407)).toBe('network');
    expect(kindFromHttpStatus(408)).toBe('timeout');
    expect(kindFromHttpStatus(500)).toBe('server');
    expect(kindFromHttpStatus(503)).toBe('server');
  });

  it('WebSocket close code and reason', () => {
    expect(kindFromCloseCode(1008, 'API key not valid. Please pass a valid API key.')).toBe('auth');
    expect(kindFromCloseCode(1008, 'Quota exceeded')).toBe('quota');
    expect(kindFromCloseCode(1007, 'Request contains an invalid argument.')).toBe('protocol');
    expect(kindFromCloseCode(1008, '')).toBe('protocol');
    expect(kindFromCloseCode(1011, 'Internal error')).toBe('server');
    expect(kindFromCloseCode(1013, '')).toBe('server');
    expect(kindFromCloseCode(1006, '')).toBe('network');
    expect(kindFromCloseCode(1000, 'idle')).toBe('network');
    expect(kindFromCloseCode(1001, '')).toBe('network');
    expect(kindFromCloseCode(4000, 'custom')).toBe('unknown');
  });

  it('provider error frames: the code first, then the text', () => {
    expect(kindFromProviderError('Arrearage', 'Access denied, please make sure your account is in good standing.', 'protocol')).toBe('quota');
    expect(kindFromProviderError('InvalidApiKey', 'Invalid API-key provided.', 'protocol')).toBe('auth');
    expect(kindFromProviderError('Throttling.RateQuota', 'Requests rate limit exceeded', 'protocol')).toBe('quota');
    expect(kindFromProviderError('invalid_api_key', 'Incorrect API key provided', 'protocol')).toBe('auth');
    expect(kindFromProviderError('insufficient_quota', 'You exceeded your current quota', 'protocol')).toBe('quota');
    expect(kindFromProviderError(undefined, 'server_error The server had an error', 'protocol')).toBe('server');
    expect(kindFromProviderError('invalid_request_error', 'unsupported language', 'protocol')).toBe('protocol');
    expect(kindFromProviderError(401, 'nope', 'protocol')).toBe('auth');
    expect(kindFromProviderError('RequestTimeOut', 'Request timed out', 'protocol')).toBe('timeout');
    expect(kindFromProviderError(undefined, 'something odd', 'unknown')).toBe('unknown');
  });

  it('free-text hints stay conservative', () => {
    expect(hintedKind('')).toBeUndefined();
    expect(hintedKind('insufficient permissions')).toBe('auth');
    expect(hintedKind('API key quota exceeded')).toBe('quota');
    expect(hintedKind('Deadline exceeded')).toBe('timeout');
    expect(hintedKind('node.js 3.5 yuan')).toBeUndefined();
    expect(hintedKind('服务器繁忙')).toBe('server');
    expect(hintedKind('账户欠费')).toBe('quota');
  });
});
