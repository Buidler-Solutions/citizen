export {}

const INPAGE_RESPONSE_TARGET = 'citizen-wallet-inpage';
const CONTENT_REQUEST_TARGET = 'citizen-wallet-content';

function injectProvider() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inpage.js');
  script.type = 'text/javascript';
  script.async = false;
  (document.head ?? document.documentElement).appendChild(script);
  script.onload = () => script.remove();
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window || !event.data || event.data.target !== CONTENT_REQUEST_TARGET) {
    return;
  }

  const { id, method, params } = event.data as {
    id: string;
    method: string;
    params?: unknown[];
  };

  chrome.runtime.sendMessage(
    {
      method,
      params,
      origin: window.location.origin,
    },
    (response: { ok: boolean; result?: unknown; error?: string } | undefined) => {
      const runtimeError = chrome.runtime.lastError;
      const payload = runtimeError
        ? { id, ok: false, error: runtimeError.message }
        : response
          ? { id, ...response }
          : { id, ok: false, error: 'No wallet response' };

      window.postMessage({ target: INPAGE_RESPONSE_TARGET, ...payload }, '*');
    },
  );
});

injectProvider();
