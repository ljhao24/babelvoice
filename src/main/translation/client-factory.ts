/**
 * Mints a TranslationClient for the requested engine. The only place
 * in main that knows the EngineId → constructor mapping; the
 * SessionOrchestrator calls this once per session start. See ADR-0002.
 */
import type { EngineId } from '@shared/engine-types.js';
import { DoubaoClient } from './doubao-client.js';
import { QwenClient } from './qwen-client.js';
import { GeminiClient } from './gemini-client.js';
import { OpenAiClient } from './openai-client.js';
import { MockTranslationClient } from './mock-client.js';
import type {
  TranslationClient,
  TranslationClientOptions
} from './translation-client.js';

export const createTranslationClient = (
  engineId: EngineId,
  opts: TranslationClientOptions
): TranslationClient => {
  switch (engineId) {
    case 'doubao':
      return new DoubaoClient(opts);
    case 'qwen':
      return new QwenClient(opts);
    case 'gemini':
      return new GeminiClient(opts);
    case 'openai':
      return new OpenAiClient(opts);
    case 'mock':
      return new MockTranslationClient(opts);
    default:
      // Unreachable for typed callers, but engine ids come from persisted,
      // cloud-synced prefs: one written by a newer build must fail here,
      // loudly, rather than hand back `undefined`.
      throw new Error(`Unknown translation engine: ${String(engineId)}`);
  }
};
