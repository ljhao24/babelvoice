import { describe, expect, it, vi } from 'vitest';

// direction-session pulls in the window manager and the native bridge; the
// clients pull in the vault (electron-store) and the proxy resolver.
vi.mock('../window-manager.js', () => ({ ensureSubtitleOverlayReady: async () => undefined }));
vi.mock('../sessions/pcm-source.js', () => ({ createPcmSource: () => null }));
vi.mock('../sessions/tts-sink.js', () => ({ createTtsSink: () => null }));
vi.mock('./credential-vault.js', () => ({
  MissingCredentialsError: class MissingCredentialsError extends Error {}
}));
vi.mock('./proxy-agent.js', () => ({ resolveProxyAgent: async () => undefined }));

const { FINISH_DEADLINE_MS } = await import('../sessions/direction-session.js');
const { GeminiClient, GEMINI_FINISH_MAX_MS } = await import('./gemini-client.js');
const { OpenAiClient, OPENAI_FINISH_MAX_MS } = await import('./openai-client.js');
const { QwenClient, QWEN_FINISH_FALLBACK_MS } = await import('./qwen-client.js');

/**
 * DirectionSession arms FINISH_DEADLINE_MS just before calling
 * client.finish(), which arms the client's own budget. With equal budgets the
 * session timer always fires first (Node runs equal timers in creation
 * order), cancels the client and drops the trailing lines + session-finished
 * the client fallback exists to deliver — and closes the TTS unit, which a
 * normal finish avoids. Keep a clear margin, not just "less than".
 */
const MARGIN_MS = 1_000;

const onEvent = (): void => undefined;
/** The budget a client is actually constructed with (private field). */
const finishMaxOf = (client: object): number =>
  (client as unknown as { timings: { finishMaxMs: number } }).timings.finishMaxMs;

describe('client finish budgets vs DirectionSession FINISH_DEADLINE_MS', () => {
  it('Gemini finishMaxMs leaves the session deadline room', () => {
    expect(GEMINI_FINISH_MAX_MS).toBeLessThanOrEqual(FINISH_DEADLINE_MS - MARGIN_MS);
    expect(finishMaxOf(new GeminiClient({ onEvent }))).toBe(GEMINI_FINISH_MAX_MS);
  });

  it('OpenAI finishMaxMs leaves the session deadline room', () => {
    expect(OPENAI_FINISH_MAX_MS).toBeLessThanOrEqual(FINISH_DEADLINE_MS - MARGIN_MS);
    expect(finishMaxOf(new OpenAiClient({ onEvent }))).toBe(OPENAI_FINISH_MAX_MS);
  });

  it('Qwen sends session.finish well before the session deadline', () => {
    expect(QWEN_FINISH_FALLBACK_MS).toBeLessThanOrEqual(FINISH_DEADLINE_MS - MARGIN_MS);
    const client = new QwenClient({ onEvent }) as unknown as { finishFallbackMs: number };
    expect(client.finishFallbackMs).toBe(QWEN_FINISH_FALLBACK_MS);
  });
});
