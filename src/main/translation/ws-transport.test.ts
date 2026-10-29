import { EventEmitter } from 'node:events';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import type { Agent } from 'node:http';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { setLogSink } from '@core/utils/logger.js';
import { TranslationError } from './translation-error.js';
import {
  BackpressureGuard,
  createStartGate,
  openSocket,
  resolveAgentWithin,
  startKeepalive,
  type KeepaliveSocket
} from './ws-transport.js';

class FakeSocket extends EventEmitter implements KeepaliveSocket {
  readyState: number = WebSocket.OPEN;
  pings = 0;
  ping(): void {
    this.pings++;
  }
}

const silentSink = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe('startKeepalive', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pings on every interval and declares the peer dead after the timeout', () => {
    vi.useFakeTimers();
    const ws = new FakeSocket();
    const onDead = vi.fn();
    startKeepalive(ws, { intervalMs: 10_000, timeoutMs: 30_000, onDead });

    vi.advanceTimersByTime(20_000);
    expect(ws.pings).toBe(2);
    expect(onDead).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10_000);
    expect(onDead).toHaveBeenCalledTimes(1);

    // Stopped itself: no more pings, no second onDead.
    vi.advanceTimersByTime(60_000);
    expect(ws.pings).toBe(2);
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it('treats pongs and inbound messages as liveness', () => {
    vi.useFakeTimers();
    const ws = new FakeSocket();
    const onDead = vi.fn();
    startKeepalive(ws, { intervalMs: 10_000, timeoutMs: 30_000, onDead });

    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(10_000);
      ws.emit(i % 2 ? 'pong' : 'message');
    }
    expect(onDead).not.toHaveBeenCalled();
  });

  it('stop() clears the interval and listeners', () => {
    vi.useFakeTimers();
    const ws = new FakeSocket();
    const onDead = vi.fn();
    const stop = startKeepalive(ws, { intervalMs: 10_000, timeoutMs: 30_000, onDead });
    stop();
    stop();
    vi.advanceTimersByTime(120_000);
    expect(ws.pings).toBe(0);
    expect(onDead).not.toHaveBeenCalled();
    expect(ws.listenerCount('pong')).toBe(0);
    expect(ws.listenerCount('message')).toBe(0);
  });
});

describe('BackpressureGuard', () => {
  beforeAll(() => setLogSink(silentSink));
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops only above the threshold and rate-limits its warning', () => {
    vi.useFakeTimers();
    silentSink.warn.mockClear();
    const guard = new BackpressureGuard(() => 'Test[]', 1000, 5000);

    expect(guard.shouldDrop(1000)).toBe(false);
    expect(guard.shouldDrop(1001)).toBe(true);
    expect(guard.shouldDrop(5000)).toBe(true);
    expect(silentSink.warn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5000);
    expect(guard.shouldDrop(5000)).toBe(true);
    expect(silentSink.warn).toHaveBeenCalledTimes(2);
  });
});

/**
 * An HTTP proxy that accepts the TCP connection and then never answers the
 * CONNECT — what a dead Clash/Surge/corporate proxy looks like.
 */
const startBlackHoleProxy = async (): Promise<{
  url: string;
  sockets: Set<Socket>;
  close: () => Promise<void>;
}> => {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    sockets,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      })
  };
};

describe('openSocket', () => {
  it('times out a proxy that accepts TCP but never answers CONNECT', async () => {
    // ws's own handshakeTimeout never starts here: the agent hands over a
    // socket only after the CONNECT succeeds.
    const proxy = await startBlackHoleProxy();
    const agent = new HttpsProxyAgent(proxy.url);
    try {
      const { ws, opened } = openSocket('ws://127.0.0.1:9/never', {
        label: 'Test',
        handshakeTimeoutMs: 80,
        agent
      });
      await expect(opened).rejects.toThrow('Test handshake timed out after 80ms');
      await expect(opened).rejects.toMatchObject({ kind: 'timeout' });
      expect(proxy.sockets.size).toBe(1); // the CONNECT did reach the proxy
      await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED), {
        interval: 5
      });
    } finally {
      agent.destroy();
      await proxy.close();
    }
  });
});

describe('openSocket error kinds', () => {
  it('a refused upgrade is classified by its HTTP status and body', async () => {
    const statuses: Array<[number, string, string]> = [
      [401, 'invalid key', 'auth'],
      [429, 'slow down', 'quota'],
      [403, 'Arrearage', 'quota'],
      [503, 'maintenance', 'server']
    ];
    for (const [status, body, kind] of statuses) {
      const wss = new WebSocketServer({
        port: 0,
        host: '127.0.0.1',
        verifyClient: (_info, cb) => cb(false, status, body)
      });
      await new Promise<void>((r) => wss.once('listening', () => r()));
      try {
        const { opened } = openSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, {
          label: 'Test',
          provider: 'qwen',
          handshakeTimeoutMs: 2_000
        });
        const err = await opened.catch((e: unknown) => e);
        expect(err).toBeInstanceOf(TranslationError);
        expect(err).toMatchObject({ kind, httpStatus: status, provider: 'qwen' });
      } finally {
        await new Promise<void>((r) => wss.close(() => r()));
      }
    }
  });

  it('a connection that cannot be made is a network error', async () => {
    const { opened } = openSocket('ws://127.0.0.1:9/never', {
      label: 'Test',
      handshakeTimeoutMs: 2_000
    });
    const err = await opened.catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'network' });
    expect((err as Error).message).toMatch(/^Test handshake failed/);
  });
});

describe('resolveAgentWithin', () => {
  beforeAll(() => setLogSink(silentSink));
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the looked-up agent', async () => {
    const agent = {} as Agent;
    await expect(
      resolveAgentWithin(async () => agent, 'wss://example.test', 1_000, 'Test')
    ).resolves.toBe(agent);
  });

  it('connects directly when the lookup never answers', async () => {
    vi.useFakeTimers();
    silentSink.warn.mockClear();
    const lookup = resolveAgentWithin(
      () => new Promise<Agent | undefined>(() => undefined),
      'wss://example.test',
      3_000,
      'Test'
    );
    vi.advanceTimersByTime(3_000);
    await expect(lookup).resolves.toBeUndefined();
    expect(silentSink.warn).toHaveBeenCalledTimes(1);
  });

  it('propagates a failing lookup', async () => {
    await expect(
      resolveAgentWithin(
        async () => {
          throw new Error('pac broke');
        },
        'wss://example.test',
        1_000,
        'Test'
      )
    ).rejects.toThrow('pac broke');
  });
});

describe('createStartGate', () => {
  it('can be rejected before anyone awaits it without an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const gate = createStartGate();
      expect(gate.reject(new Error('canceled'))).toBe(true);
      expect(gate.reject(new Error('again'))).toBe(false);
      expect(gate.resolve()).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();
      // A later await still observes the rejection.
      await expect(gate.promise).rejects.toThrow('canceled');
      expect(gate.settled).toBe(true);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
