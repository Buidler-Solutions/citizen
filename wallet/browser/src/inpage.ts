export {}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

const pending = new Map<string, PendingRequest>();
const CONTENT_REQUEST_TARGET = 'citizen-wallet-content';
const INPAGE_RESPONSE_TARGET = 'citizen-wallet-inpage';

function request(method: string, params?: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    pending.set(id, { resolve, reject });
    window.postMessage(
      {
        target: CONTENT_REQUEST_TARGET,
        id,
        method,
        params,
      },
      '*',
    );
  });
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window || !event.data || event.data.target !== INPAGE_RESPONSE_TARGET) {
    return;
  }

  const { id, ok, result, error } = event.data as {
    id: string;
    ok: boolean;
    result?: unknown;
    error?: string;
  };

  const tracked = pending.get(id);
  if (!tracked) {
    return;
  }

  pending.delete(id);
  if (ok) {
    tracked.resolve(result);
  } else {
    tracked.reject(new Error(error ?? 'Wallet request failed'));
  }
});

const provider = {
  isMetaMask: false,
  isCitizenWallet: true,
  request: ({ method, params }: { method: string; params?: unknown[] }) => request(method, params),
};

Object.defineProperty(window, 'citizen', {
  value: provider,
  configurable: false,
  writable: false,
});

Object.defineProperty(window, 'ethereum', {
  value: provider,
  configurable: false,
  writable: false,
});

window.dispatchEvent(new Event('citizen#initialized'));
window.dispatchEvent(new Event('ethereum#initialized'));
