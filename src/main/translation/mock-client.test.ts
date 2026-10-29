import { describe, expect, it } from 'vitest';
import { MockTranslationClient } from './mock-client.js';
import type { TranslationEventBody } from './translation-client.js';

const start = async (): Promise<{
  client: MockTranslationClient;
  events: TranslationEventBody[];
}> => {
  const events: TranslationEventBody[] = [];
  const client = new MockTranslationClient({ onEvent: (e) => events.push(e) });
  await client.start({
    engineId: 'mock',
    sourceLanguage: 'zh',
    targetLanguage: 'en',
    mode: 's2t'
  });
  return { client, events };
};

describe('MockTranslationClient terminal events', () => {
  it('finish() is idempotent: one session-finished', async () => {
    const { client, events } = await start();
    await client.finish();
    await client.finish();
    expect(events.map((e) => e.type)).toEqual(['session-started', 'session-finished']);
  });

  it('emits nothing on or after cancel(), including a later finish()', async () => {
    const { client, events } = await start();
    await client.cancel();
    await client.finish();
    await client.cancel();
    expect(events.map((e) => e.type)).toEqual(['session-started']);
  });
});

describe('MockTranslationClient lifecycle (same contract as the real clients)', () => {
  const PARAMS = {
    engineId: 'mock',
    sourceLanguage: 'zh',
    targetLanguage: 'en',
    mode: 's2t'
  } as const;

  it('cancel() before start() makes start() reject and emit nothing', async () => {
    const events: TranslationEventBody[] = [];
    const client = new MockTranslationClient({ onEvent: (e) => events.push(e) });
    await client.cancel();
    await expect(client.start(PARAMS)).rejects.toThrow(/canceled/);
    expect(events).toEqual([]);
  });

  it('a second start() rejects, live or after finish()', async () => {
    const { client, events } = await start();
    await expect(client.start(PARAMS)).rejects.toThrow('already started');
    await client.finish();
    await expect(client.start(PARAMS)).rejects.toThrow('already started');
    expect(events.map((e) => e.type)).toEqual(['session-started', 'session-finished']);
  });
});
