import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StartTranslationParams } from '@shared/ipc-types.js';
import type {
  EngineConfigs,
  DoubaoEngineConfig
} from '@shared/engine-types.js';

// Mocks must be hoisted above the SUT import so the SUT picks up the
// mocked exports rather than the real config store.
const prefsState = {
  // `string`: stored prefs may carry an id this build doesn't know.
  engineId: 'doubao' as string,
  engineConfigs: {
    doubao: {
      speakerVoice: 'clone',
      glossary: {},
      hotWords: [],
      correctWords: {}
    } as DoubaoEngineConfig,
    qwen: { voice: 'Tina' }
  } as EngineConfigs
};

vi.mock('../config-store.js', () => ({
  getPreferences: () => prefsState
}));

// Imported AFTER mocks so the module sees the mocked deps.
import { setLogSink } from '@core/utils/logger.js';
import { buildClientStartParams, getActiveEngineId } from './engine-selection.js';
import type { EngineId } from '@shared/engine-types.js';

const ENVELOPE: StartTranslationParams = {
  direction: 'speak',
  sourceLanguage: 'zh',
  targetLanguage: 'en',
  mode: 's2s'
};

const POPULATED_DOUBAO: DoubaoEngineConfig = {
  speakerVoice: 'clone',
  glossary: { 豆包: 'Doubao' },
  hotWords: ['BabelVoice'],
  correctWords: { '语音': 'voice' }
};

beforeEach(() => {
  prefsState.engineId = 'doubao';
  prefsState.engineConfigs = {
    doubao: {
      speakerVoice: 'clone',
      glossary: {},
      hotWords: [],
      correctWords: {}
    },
    qwen: { voice: 'Tina' }
  };
});

describe('buildClientStartParams — corpus', () => {
  it('stored corpus: forwards the corpus block', () => {
    prefsState.engineConfigs.doubao = POPULATED_DOUBAO;

    const params = buildClientStartParams(ENVELOPE, 'doubao');

    expect(params.engineId).toBe('doubao');
    expect('corpus' in params).toBe(true);
    if (params.engineId === 'doubao' && params.corpus) {
      expect(params.corpus.glossary_list).toEqual({ 豆包: 'Doubao' });
      expect(params.corpus.hot_words_list).toEqual(['BabelVoice']);
      // correct_words is JSON-stringified per Doubao API contract.
      expect(params.corpus.correct_words).toBe(
        JSON.stringify({ '语音': 'voice' })
      );
    }
  });

  it('empty corpus: drops the field', () => {
    const params = buildClientStartParams(ENVELOPE, 'doubao');

    // The whole `corpus` field must be absent — we deliberately don't even
    // ship an empty object. doubao-codec relies on its presence to decide
    // whether to encode the corpus block.
    expect('corpus' in params).toBe(false);
  });

  it('non-Doubao engine: qwen passes through unchanged', () => {
    const params = buildClientStartParams(ENVELOPE, 'qwen');

    expect(params.engineId).toBe('qwen');
    if (params.engineId === 'qwen') {
      expect(params.voice).toBe('Tina');
    }
  });
});

describe('buildClientStartParams — qwen voice cloning', () => {
  it('speak clones once (one speaker) and sends no preset voice', () => {
    prefsState.engineConfigs.qwen = { voice: 'clone' };

    const params = buildClientStartParams(ENVELOPE, 'qwen');

    expect(params).toMatchObject({ engineId: 'qwen', voiceClone: 'once' });
    expect('voice' in params).toBe(false);
  });

  it('listen re-clones per output so the voice follows the speaker', () => {
    prefsState.engineConfigs.qwen = { voice: 'clone' };

    const params = buildClientStartParams(
      { ...ENVELOPE, direction: 'listen' },
      'qwen'
    );

    expect(params).toMatchObject({ engineId: 'qwen', voiceClone: 'always' });
  });

  it('a preset voice is sent as-is, without cloning', () => {
    prefsState.engineConfigs.qwen = { voice: 'Ethan' };

    const params = buildClientStartParams(ENVELOPE, 'qwen');

    expect(params).toMatchObject({ engineId: 'qwen', voice: 'Ethan' });
    expect('voiceClone' in params).toBe(false);
  });
});

describe('getActiveEngineId', () => {
  const warn = vi.fn();
  beforeEach(() => {
    warn.mockReset();
    setLogSink({ info() {}, warn, error() {}, debug() {} });
  });

  it('returns the stored engine when this build knows it', () => {
    prefsState.engineId = 'gemini';
    expect(getActiveEngineId()).toBe('gemini');
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to the default engine for an unknown id, warning once per value', () => {
    // A newer build on another device picked an engine we don't ship.
    prefsState.engineId = 'whisper';
    expect(getActiveEngineId()).toBe('doubao');
    expect(getActiveEngineId()).toBe('doubao');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/unknown engineId "whisper"/);

    prefsState.engineId = '';
    expect(getActiveEngineId()).toBe('doubao');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('buildClientStartParams rejects an unknown engine instead of returning undefined', () => {
    expect(() => buildClientStartParams(ENVELOPE, 'whisper' as EngineId)).toThrow(
      'Unknown translation engine: whisper'
    );
  });
});

describe('buildClientStartParams — openai', () => {
  it('carries only the universal translation intent', () => {
    const params = buildClientStartParams(ENVELOPE, 'openai');

    expect(params).toEqual({
      engineId: 'openai',
      sourceLanguage: 'zh',
      targetLanguage: 'en',
      mode: 's2s'
    });
  });
});
