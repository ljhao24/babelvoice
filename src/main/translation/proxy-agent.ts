/**
 * Proxy resolution for provider sockets that leave the mainland network
 * (today: Gemini). Node's `ws` ignores the macOS system proxy, so a user
 * running Clash / Surge / a corporate PAC would otherwise hit ETIMEDOUT on
 * `generativelanguage.googleapis.com`. Chromium already knows the answer —
 * `session.resolveProxy()` honours system settings and PAC scripts — so we
 * ask it and wrap the result in an HTTP CONNECT agent for `ws`.
 *
 * Doubao / Qwen endpoints are domestic and deliberately keep connecting
 * directly; routing them through an overseas proxy only adds latency.
 */
import type { Agent } from 'node:http';
import { session } from 'electron';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { log } from '@core/utils/logger.js';

/**
 * Env override, mainly for dev shells (`HTTPS_PROXY=http://127.0.0.1:7897`).
 * Only http(s) proxies are supported — `ws` + CONNECT is all we need.
 */
const envProxyUrl = (): string | undefined => {
  const raw =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.ALL_PROXY ??
    process.env.all_proxy;
  return raw && /^https?:\/\//i.test(raw) ? raw : undefined;
};

/**
 * Turn a Chromium PAC result (`"PROXY 127.0.0.1:7897; DIRECT"`) into the
 * proxy URL to tunnel through, or `undefined` for a direct connection.
 * Entries are tried in order; SOCKS entries are skipped because the only
 * agent we ship speaks HTTP CONNECT (Clash/Surge expose both on the same
 * mixed port, so the PROXY entry is virtually always present).
 */
export const proxyUrlFromPacResult = (pac: string): string | undefined => {
  for (const entry of pac.split(';')) {
    const [kind, hostPort] = entry.trim().split(/\s+/, 2);
    switch (kind?.toUpperCase()) {
      case 'DIRECT':
        return undefined;
      case 'PROXY':
        if (hostPort) return `http://${hostPort}`;
        break;
      case 'HTTPS':
        if (hostPort) return `https://${hostPort}`;
        break;
      default:
        // SOCKS / SOCKS4 / SOCKS5 / empty — try the next entry.
        break;
    }
  }
  return undefined;
};

/** Resolve the agent `ws` should use to reach `targetUrl` (ws:// or wss://). */
export const resolveProxyAgent = async (
  targetUrl: string
): Promise<Agent | undefined> => {
  const fromEnv = envProxyUrl();
  if (fromEnv) return new HttpsProxyAgent(fromEnv);

  // Chromium resolves proxies per http(s) scheme; ask with the scheme the
  // CONNECT tunnel will actually carry.
  const httpUrl = targetUrl.replace(/^ws(s?):/i, 'http$1:');
  let pac: string;
  try {
    pac = await session.defaultSession.resolveProxy(httpUrl);
  } catch (err) {
    log.warn('resolveProxy failed; connecting directly:', err);
    return undefined;
  }
  const proxyUrl = proxyUrlFromPacResult(pac);
  if (!proxyUrl) {
    if (/SOCKS/i.test(pac)) {
      log.warn(
        `only SOCKS proxies configured (${pac}); connecting directly — set HTTPS_PROXY to an HTTP proxy if this fails`
      );
    }
    return undefined;
  }
  return new HttpsProxyAgent(proxyUrl);
};
