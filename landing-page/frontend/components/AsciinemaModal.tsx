'use client';

import { useEffect, useRef, useState } from 'react';

const ASCIINEMA_PLAYER_SCRIPT_ID = 'asciinema-player-script';
const ASCIINEMA_PLAYER_STYLES_ID = 'asciinema-player-styles';

const ASCIINEMA_PLAYER_SCRIPT_SOURCES = [
  'https://cdn.jsdelivr.net/npm/asciinema-player@3.10.0/dist/bundle/asciinema-player.min.js',
  'https://unpkg.com/asciinema-player@3.10.0/dist/bundle/asciinema-player.min.js',
  'https://asciinema.org/a/player.js',
];

const ASCIINEMA_PLAYER_STYLE_SOURCES = [
  'https://cdn.jsdelivr.net/npm/asciinema-player@3.10.0/dist/bundle/asciinema-player.css',
  'https://unpkg.com/asciinema-player@3.10.0/dist/bundle/asciinema-player.css',
  'https://asciinema.org/a/player.css',
];

const normalizeShortcodeToken = (token: string): string => token
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9-]+/g, '-')
  .replace(/^-+|-+$/g, '');

type AsciinemaPlayerInstance = {
  dispose?: () => void;
};

declare global {
  interface Window {
    AsciinemaPlayer?: {
      create: (
        src: string,
        target: HTMLElement,
        options: {
          autoplay?: boolean;
          preload?: boolean;
          fit?: 'width' | 'height' | 'none';
        }
      ) => AsciinemaPlayerInstance;
    };
  }
}

interface AsciinemaModalProps {
  isOpen: boolean;
  recordingUrl: string;
  onClose: () => void;
  shortcodeMap?: Record<string, string>;
}

const resolveShortcodeSource = (recordingUrl: string, shortcodeMap: Record<string, string>): string => {
  const trimmed = recordingUrl.trim();
  const match = trimmed.match(/^\[asciinema:([a-zA-Z0-9_-]+)\]$/);

  if (!match) {
    return trimmed;
  }

  const shortcode = normalizeShortcodeToken(match[1]);
  return shortcodeMap[shortcode] ?? trimmed;
};

const extractCastSource = (recordingUrl: string): string => {
  const trimmed = recordingUrl.trim();

  if (trimmed.endsWith('.cast')) {
    return trimmed;
  }

  const match = trimmed.match(/^https?:\/\/asciinema\.org\/a\/([a-zA-Z0-9_-]+)(?:\/.*)?$/);
  if (!match) {
    return trimmed;
  }

  return `https://asciinema.org/a/${match[1]}.cast`;
};

const loadScriptSource = async (src: string): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.crossOrigin = 'anonymous';

    script.onload = () => {
      script.id = ASCIINEMA_PLAYER_SCRIPT_ID;
      resolve();
    };
    script.onerror = () => {
      script.remove();
      reject(new Error(`Unable to load script source: ${src}`));
    };

    document.body.appendChild(script);
  });
};

const ensurePlayerAssets = async (): Promise<void> => {
  if (!document.getElementById(ASCIINEMA_PLAYER_STYLES_ID)) {
    const stylesheet = document.createElement('link');
    stylesheet.id = ASCIINEMA_PLAYER_STYLES_ID;
    stylesheet.rel = 'stylesheet';
    stylesheet.href = ASCIINEMA_PLAYER_STYLE_SOURCES[0];
    stylesheet.crossOrigin = 'anonymous';
    document.head.appendChild(stylesheet);

    stylesheet.addEventListener('error', () => {
      const fallbackHref = ASCIINEMA_PLAYER_STYLE_SOURCES.find((href) => href !== stylesheet.href);
      if (fallbackHref) {
        stylesheet.href = fallbackHref;
      }
    }, { once: true });
  }

  if (window.AsciinemaPlayer) {
    return;
  }

  const existingScript = document.getElementById(ASCIINEMA_PLAYER_SCRIPT_ID) as HTMLScriptElement | null;
  if (existingScript) {
    await new Promise<void>((resolve, reject) => {
      existingScript.addEventListener('load', () => resolve(), { once: true });
      existingScript.addEventListener('error', () => reject(new Error('Unable to load existing Asciinema player script')), { once: true });
    });
    return;
  }

  let lastError: Error | null = null;
  for (const scriptSource of ASCIINEMA_PLAYER_SCRIPT_SOURCES) {
    try {
      await loadScriptSource(scriptSource);
      if (window.AsciinemaPlayer) {
        return;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Unable to load Asciinema player script');
    }
  }

  throw lastError ?? new Error('Unable to load Asciinema player script');
};

export function AsciinemaModal({ isOpen, recordingUrl, onClose, shortcodeMap = {} }: AsciinemaModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const playerInstanceRef = useRef<AsciinemaPlayerInstance | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const previousActiveElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const modalElement = modalRef.current;
    const focusableSelector = [
      'a[href]',
      'button:not([disabled])',
      'textarea:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(', ');

    const focusFirstElement = () => {
      const focusableElements = modalElement?.querySelectorAll<HTMLElement>(focusableSelector);
      if (focusableElements && focusableElements.length > 0) {
        focusableElements[0].focus();
      } else {
        modalElement?.focus();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== 'Tab' || !modalElement) {
        return;
      }

      const focusableElements = Array.from(modalElement.querySelectorAll<HTMLElement>(focusableSelector));
      if (focusableElements.length === 0) {
        event.preventDefault();
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      }

      if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    document.body.style.overflow = 'hidden';
    focusFirstElement();
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
      previousActiveElement?.focus();
    };
  }, [isOpen, onClose]);

  useEffect(() => {
    const playerContainer = playerContainerRef.current;
    if (!isOpen || !playerContainer) {
      return;
    }

    let canceled = false;

    const mountPlayer = async () => {
      try {
        setPlayerError(null);
        await ensurePlayerAssets();
        if (canceled || !window.AsciinemaPlayer) {
          return;
        }

        const source = extractCastSource(resolveShortcodeSource(recordingUrl, shortcodeMap));
        playerContainer.innerHTML = '';
        playerInstanceRef.current = window.AsciinemaPlayer.create(source, playerContainer, {
          autoplay: true,
          preload: true,
          fit: 'height',
        });
      } catch {
        if (!canceled) {
          setPlayerError('Unable to load terminal player assets. Please refresh and try again.');
        }
      }
    };

    void mountPlayer();

    return () => {
      canceled = true;
      playerInstanceRef.current?.dispose?.();
      playerInstanceRef.current = null;
      playerContainer.innerHTML = '';
    };
  }, [isOpen, recordingUrl, shortcodeMap]);

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/90"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      aria-hidden={false}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Asciinema terminal recording"
        className="flex h-screen w-screen flex-col bg-slate-950 p-4 sm:p-6"
        tabIndex={-1}
      >
        <div className="mb-4 flex items-center justify-between border-b border-slate-800 pb-4">
          <h2 className="text-base font-semibold text-slate-100 sm:text-lg">Terminal walkthrough</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-slate-600 p-2 text-slate-200 transition-colors hover:border-slate-400 hover:text-white"
            aria-label="Close terminal recording modal"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-hidden rounded-xl border border-slate-800 bg-black p-2 sm:p-3">
          {playerError ? (
            <div className="grid min-h-[240px] place-items-center p-4 text-center text-sm text-red-200 sm:min-h-[320px]">
              <p>{playerError}</p>
            </div>
          ) : (
            <div ref={playerContainerRef} className="asciinema-player-wrapper h-full min-h-[240px] w-full" />
          )}
        </div>
      </div>
    </div>
  );
}
