const GSAP_CDN_URL = 'https://cdnjs.cloudflare.com/ajax/libs/gsap/3.13.0/gsap.min.js';
const GSAP_SCROLL_TO_CDN_URL = 'https://cdnjs.cloudflare.com/ajax/libs/gsap/3.13.0/ScrollToPlugin.min.js';

let gsapLoaderPromise: Promise<void> | null = null;
let gsapScrollLoaderPromise: Promise<void> | null = null;

declare global {
  interface Window {
    gsap?: {
      to: (targets: unknown, vars: Record<string, unknown>) => unknown;
      fromTo: (targets: unknown, fromVars: Record<string, unknown>, toVars: Record<string, unknown>) => unknown;
      context: (fn: () => void, scope?: Element | null) => { revert: () => void };
      registerPlugin?: (...plugins: unknown[]) => void;
    };
    ScrollToPlugin?: unknown;
  }
}

const loadScriptOnce = (src: string, dataKey: string) => new Promise<void>((resolve, reject) => {
  const existingScript = document.querySelector<HTMLScriptElement>(`script[data-${dataKey}="true"]`);

  if (existingScript) {
    if (existingScript.dataset.loaded === 'true') {
      resolve();
      return;
    }

    existingScript.addEventListener('load', () => resolve(), { once: true });
    existingScript.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
    return;
  }

  const script = document.createElement('script');
  script.src = src;
  script.async = true;
  script.dataset[dataKey] = 'true';
  script.onload = () => {
    script.dataset.loaded = 'true';
    resolve();
  };
  script.onerror = () => reject(new Error(`Failed to load ${src}`));
  document.head.appendChild(script);
});

export const ensureGsap = () => {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.gsap) return Promise.resolve();
  if (gsapLoaderPromise) return gsapLoaderPromise;

  gsapLoaderPromise = loadScriptOnce(GSAP_CDN_URL, 'gsapCdn');
  return gsapLoaderPromise;
};

export const ensureGsapWithScrollTo = () => {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.gsap && window.ScrollToPlugin) return Promise.resolve();
  if (gsapScrollLoaderPromise) return gsapScrollLoaderPromise;

  gsapScrollLoaderPromise = ensureGsap()
    .then(() => loadScriptOnce(GSAP_SCROLL_TO_CDN_URL, 'gsapScrollPluginCdn'))
    .then(() => {
      if (window.gsap?.registerPlugin && window.ScrollToPlugin) {
        window.gsap.registerPlugin(window.ScrollToPlugin);
      }
    });

  return gsapScrollLoaderPromise;
};
