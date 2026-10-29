import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ session: {} }));

const { proxyUrlFromPacResult } = await import('./proxy-agent.js');

describe('proxyUrlFromPacResult', () => {
  it('uses the first HTTP proxy entry', () => {
    expect(proxyUrlFromPacResult('PROXY 127.0.0.1:7897')).toBe('http://127.0.0.1:7897');
    expect(proxyUrlFromPacResult('PROXY 127.0.0.1:7897; DIRECT')).toBe(
      'http://127.0.0.1:7897'
    );
    expect(proxyUrlFromPacResult('HTTPS proxy.corp:443')).toBe('https://proxy.corp:443');
  });

  it('connects directly when Chromium says DIRECT first', () => {
    expect(proxyUrlFromPacResult('DIRECT')).toBeUndefined();
    expect(proxyUrlFromPacResult('DIRECT; PROXY 127.0.0.1:7897')).toBeUndefined();
  });

  it('skips SOCKS entries it cannot tunnel through', () => {
    expect(proxyUrlFromPacResult('SOCKS5 127.0.0.1:7897; PROXY 127.0.0.1:7890')).toBe(
      'http://127.0.0.1:7890'
    );
    expect(proxyUrlFromPacResult('SOCKS5 127.0.0.1:7897')).toBeUndefined();
  });
});
