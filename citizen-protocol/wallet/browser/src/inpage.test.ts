// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

declare global {
  interface Window {
    ethereum?: {
      isCitizenWallet: boolean;
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
    citizen?: {
      isCitizenWallet: boolean;
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
  }
}

describe('browser wallet provider injection and signing smoke flow', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  it('injects provider and resolves personal_sign requests through content bridge', async () => {
    let captured: { method: string; params?: unknown[] } | null = null;

    const handler = (event: MessageEvent) => {
      if (event.data?.target !== 'citizen-wallet-content') {
        return;
      }

      captured = {
        method: event.data.method as string,
        params: event.data.params as unknown[] | undefined,
      };

      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            target: 'citizen-wallet-inpage',
            id: event.data.id,
            ok: true,
            result: '0xsigned-smoke-result',
          },
          source: window,
        }),
      );
    };

    window.addEventListener('message', handler);
    await import('./inpage');

    expect(window.ethereum?.isCitizenWallet).toBe(true);
    expect(window.citizen?.isCitizenWallet).toBe(true);

    const signature = await window.ethereum!.request({
      method: 'personal_sign',
      params: ['hello-citizen', '0xabc'],
    });

    expect(captured).toEqual({ method: 'personal_sign', params: ['hello-citizen', '0xabc'] });
    expect(signature).toBe('0xsigned-smoke-result');

    window.removeEventListener('message', handler);
  });

  it('content script forwards injected page requests to extension runtime', async () => {
    const runtimeSendMessage = vi.fn((payload: unknown, callback: (response: unknown) => void) => {
      callback({ ok: true, result: '0xruntime-signed' });
    });

    Object.assign(globalThis, {
      chrome: {
        runtime: {
          getURL: vi.fn((path: string) => `chrome-extension://wallet/${path}`),
          sendMessage: runtimeSendMessage,
          lastError: null,
        },
      },
    });

    let contentMessageListener: ((event: MessageEvent) => void) | null = null;
    const originalAddEventListener = window.addEventListener.bind(window);
    vi.spyOn(window, 'addEventListener').mockImplementation((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (type === 'message' && contentMessageListener === null && typeof listener === 'function') {
        contentMessageListener = listener as (event: MessageEvent) => void;
      }
      return originalAddEventListener(type, listener, options);
    });

    await import('./content');

    const responsePromise = new Promise<{ target: string; result: string }>((resolve) => {
      window.addEventListener(
        'message',
        (event: MessageEvent) => {
          if (event.data?.target === 'citizen-wallet-inpage') {
            resolve(event.data as { target: string; result: string });
          }
        },
        { once: true },
      );
    });

    expect(contentMessageListener).not.toBeNull();
    contentMessageListener!({
      source: window,
      data: {
        target: 'citizen-wallet-content',
        id: 'smoke-1',
        method: 'personal_sign',
        params: ['payload', '0xabc'],
      },
    } as unknown as MessageEvent);

    const response = await responsePromise;

    expect(runtimeSendMessage).toHaveBeenCalledWith(
      {
        method: 'personal_sign',
        params: ['payload', '0xabc'],
        origin: window.location.origin,
      },
      expect.any(Function),
    );
    expect(response.result).toBe('0xruntime-signed');

    const injectedScript = document.querySelector('script[src="chrome-extension://wallet/inpage.js"]');
    expect(injectedScript).not.toBeNull();
  });
});
