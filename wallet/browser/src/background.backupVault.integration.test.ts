// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@noble/curves/ed25519', () => ({
  x25519: {
    getSharedSecret: () => new Uint8Array(32),
  },
}));

type StorageState = Record<string, unknown>;

function createChromeMock(initialState: StorageState = {}) {
  const store: StorageState = { ...initialState };

  return {
    runtime: {
      id: 'test-extension-id',
      getURL: vi.fn((path: string) => `chrome-extension://test-extension-id/${path}`),
      onMessage: {
        addListener: vi.fn(),
      },
    },
    sidePanel: {
      setPanelBehavior: vi.fn(() => Promise.resolve()),
    },
    storage: {
      local: {
        get: vi.fn(async (keys?: string | string[] | Record<string, unknown>) => {
          if (!keys) {
            return { ...store };
          }
          if (typeof keys === 'string') {
            return { [keys]: store[keys] };
          }
          if (Array.isArray(keys)) {
            return keys.reduce<Record<string, unknown>>((acc, key) => {
              acc[key] = store[key];
              return acc;
            }, {});
          }
          return Object.keys(keys).reduce<Record<string, unknown>>((acc, key) => {
            acc[key] = store[key] ?? keys[key];
            return acc;
          }, {});
        }),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(store, values);
        }),
      },
    },
  };
}

describe('background backup vault integration flow', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    Object.assign(globalThis, {
      chrome: createChromeMock(),
    });
  });

  it('supports create/export/restore/verify lifecycle for decoy + critical slots', async () => {
    const { __testHooks } = await import('./background');
    const sender = {
      id: 'test-extension-id',
      url: 'chrome-extension://test-extension-id/index.html',
    } as chrome.runtime.MessageSender;

    const created = await __testHooks.handleWalletRequest(
      {
        method: 'wallet_createBackupVault',
        params: ['DecoyPassphrase123!', 'CriticalPassphrase123!'],
      },
      sender,
    );
    expect(created.ok).toBe(true);

    const exported = await __testHooks.handleWalletRequest(
      {
        method: 'wallet_exportBackupVault',
        params: ['critical', 'CriticalPassphrase123!'],
      },
      sender,
    );
    expect(exported.ok).toBe(true);
    if (!exported.ok) {
      return;
    }

    const payloadBase64 = (exported.result as { payloadBase64: string }).payloadBase64;
    expect(payloadBase64.length).toBeGreaterThan(40);

    const restored = await __testHooks.handleWalletRequest(
      {
        method: 'wallet_restoreBackupVault',
        params: ['critical', 'CriticalPassphrase123!', payloadBase64, 'replace'],
      },
      sender,
    );
    expect(restored.ok).toBe(true);

    const verifyMarked = await __testHooks.handleWalletRequest(
      {
        method: 'wallet_markBackupVerified',
      },
      sender,
    );
    expect(verifyMarked.ok).toBe(true);

    const posture = await __testHooks.handleWalletRequest(
      {
        method: 'wallet_getBackupPosture',
      },
      sender,
    );
    expect(posture.ok).toBe(true);
    expect((posture as { ok: true; result: { lastVerifiedAt: string | null } }).result.lastVerifiedAt).toBeTruthy();
  });
});
