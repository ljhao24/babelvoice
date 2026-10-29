import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fake Keychain: "ciphertext" is `enc:` + plaintext, and decryption can be
// made to fail (locked Keychain) or encryption to be unavailable.
const keychain = vi.hoisted(() => ({
  available: true,
  failDecrypt: false,
  decryptCalls: 0
}));
const disk = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => keychain.available,
    encryptString: (plain: string) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (buf: Buffer) => {
      keychain.decryptCalls++;
      if (keychain.failDecrypt) throw new Error('keychain locked');
      const text = buf.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('bad ciphertext');
      return text.slice('enc:'.length);
    }
  }
}));
vi.mock('electron-store', () => ({
  default: class {
    get(key: string): unknown {
      return disk.data[key];
    }
    set(key: string, value: unknown): void {
      disk.data[key] = JSON.parse(JSON.stringify(value));
    }
    delete(key: string): void {
      delete disk.data[key];
    }
  }
}));

const encBlob = (json: unknown): string =>
  Buffer.from(`enc:${JSON.stringify(json)}`, 'utf8').toString('base64');
const plainBlob = (json: unknown): string =>
  `plain:${Buffer.from(JSON.stringify(json), 'utf8').toString('base64')}`;
const stored = (): Record<string, string> =>
  (disk.data.credentials ?? {}) as Record<string, string>;

const warn = vi.fn();

/** A fresh module per test: the vault memoizes at module scope. */
const loadVault = async () => {
  vi.resetModules();
  // resetModules also re-creates the logger the vault will import.
  const { setLogSink } = await import('@core/utils/logger.js');
  setLogSink({ info() {}, warn, error() {}, debug() {} });
  return import('./credential-vault.js');
};

beforeEach(() => {
  keychain.available = true;
  keychain.failDecrypt = false;
  keychain.decryptCalls = 0;
  disk.data = {};
  warn.mockReset();
});

describe('credential-vault', () => {
  it('round-trips credentials through safeStorage', async () => {
    const vault = await loadVault();
    vault.setGeminiCredentials({ apiKey: 'AIza-1234' });
    expect(stored().gemini).toBe(encBlob({ apiKey: 'AIza-1234' }));

    const fresh = await loadVault();
    expect(fresh.getGeminiCredentials()).toEqual({ apiKey: 'AIza-1234' });
    expect(fresh.getCredentialStatus().gemini).toEqual({
      configured: true,
      apiKeyTail: '1234'
    });
  });

  it('does not memoize a blob it could not decrypt yet (keyring not available)', async () => {
    disk.data.credentials = { openai: encBlob({ apiKey: 'sk-abcd' }) };
    keychain.available = false;
    const vault = await loadVault();

    expect(vault.getOpenAiCredentials()).toBeNull();
    expect(vault.getCredentialStatus().openai.configured).toBe(false);

    keychain.available = true;
    expect(vault.getOpenAiCredentials()).toEqual({ apiKey: 'sk-abcd' });
  });

  it('retries after a failed decrypt, warning only once', async () => {
    disk.data.credentials = { qwen: encBlob({ apiKey: 'sk-qwen', workspaceId: 'llm-1' }) };
    keychain.failDecrypt = true;
    const vault = await loadVault();

    expect(vault.getQwenCredentials()).toBeNull();
    expect(vault.getQwenCredentials()).toBeNull();
    expect(keychain.decryptCalls).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);

    keychain.failDecrypt = false;
    expect(vault.getQwenCredentials()).toEqual({ apiKey: 'sk-qwen', workspaceId: 'llm-1' });
    // Memoized once readable.
    vault.getQwenCredentials();
    expect(keychain.decryptCalls).toBe(3);
  });

  it('memoizes a malformed blob as not configured (re-reading cannot fix it)', async () => {
    disk.data.credentials = { gemini: Buffer.from('enc:{nope', 'utf8').toString('base64') };
    const vault = await loadVault();
    expect(vault.getGeminiCredentials()).toBeNull();
    expect(vault.getGeminiCredentials()).toBeNull();
    expect(keychain.decryptCalls).toBe(1);
  });

  it('re-encrypts a plain: blob once safeStorage works', async () => {
    disk.data.credentials = {
      doubao: plainBlob({ appKey: 'app-1', accessKey: 'acc-1' }),
      gemini: encBlob({ apiKey: 'AIza-keep' })
    };
    const vault = await loadVault();

    expect(vault.getDoubaoCredentials()).toEqual({
      appKey: 'app-1',
      accessKey: 'acc-1',
      resourceId: 'volc.service_type.10053'
    });
    expect(stored().doubao).toBe(encBlob({ appKey: 'app-1', accessKey: 'acc-1' }));
    // Other slots are left alone.
    expect(stored().gemini).toBe(encBlob({ apiKey: 'AIza-keep' }));

    // The migrated blob reads back through safeStorage.
    const fresh = await loadVault();
    expect(fresh.getDoubaoCredentials()?.appKey).toBe('app-1');
  });

  it('keeps reading a plain: blob as-is while safeStorage is unavailable', async () => {
    disk.data.credentials = { openai: plainBlob({ apiKey: 'sk-plain' }) };
    keychain.available = false;
    const vault = await loadVault();

    expect(vault.getOpenAiCredentials()).toEqual({ apiKey: 'sk-plain' });
    expect(stored().openai).toBe(plainBlob({ apiKey: 'sk-plain' }));
  });

  it('still saves (as plain:) when safeStorage is unavailable, with a warning', async () => {
    keychain.available = false;
    const vault = await loadVault();

    vault.setOpenAiCredentials({ apiKey: 'sk-1' });
    vault.setGeminiCredentials({ apiKey: 'AIza-2' });
    expect(stored().openai).toBe(plainBlob({ apiKey: 'sk-1' }));
    expect(stored().gemini).toBe(plainBlob({ apiKey: 'AIza-2' }));
    expect(vault.getOpenAiCredentials()).toEqual({ apiKey: 'sk-1' });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('clearing a slot removes it from disk and the memo', async () => {
    const vault = await loadVault();
    vault.setGeminiCredentials({ apiKey: 'AIza-x' });
    vault.setGeminiCredentials(null);
    expect(vault.getGeminiCredentials()).toBeNull();
    expect(disk.data.credentials).toBeUndefined();
  });
});
