'use client';

import { useEffect, useRef } from 'react';

const ASCIINEMA_PLAYER_SCRIPT_ID = 'asciinema-player-script';
const ASCIINEMA_PLAYER_STYLES_ID = 'asciinema-player-styles';
const ASCIINEMA_PLAYER_SCRIPT_SRC = 'https://asciinema.org/a/player.js';
const ASCIINEMA_PLAYER_STYLES_HREF = 'https://asciinema.org/a/player.css';

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

  return shortcodeMap[match[1]] ?? trimmed;
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

const ensurePlayerAssets = async (): Promise<void> => {
  if (!document.getElementById(ASCIINEMA_PLAYER_STYLES_ID)) {
    const stylesheet = document.createElement('link');
    stylesheet.id = ASCIINEMA_PLAYER_STYLES_ID;
    stylesheet.rel = 'stylesheet';
    stylesheet.href = ASCIINEMA_PLAYER_STYLES_HREF;
    document.head.appendChild(stylesheet);
  }

  const existingScript = document.getElementById(ASCIINEMA_PLAYER_SCRIPT_ID) as HTMLScriptElement | null;
  if (existingScript && window.AsciinemaPlayer) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const script = existingScript ?? document.createElement('script');
    script.id = ASCIINEMA_PLAYER_SCRIPT_ID;
    script.src = ASCIINEMA_PLAYER_SCRIPT_SRC;
    script.async = true;

    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Unable to load Asciinema player script'));

    if (!existingScript) {
      document.body.appendChild(script);
    }
  });
};

export function AsciinemaModal({ isOpen, recordingUrl, onClose, shortcodeMap = {} }: AsciinemaModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const playerInstanceRef = useRef<AsciinemaPlayerInstance | null>(null);

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
      await ensurePlayerAssets();
      if (canceled || !window.AsciinemaPlayer) {
        return;
      }

      const source = extractCastSource(resolveShortcodeSource(recordingUrl, shortcodeMap));
      playerContainer.innerHTML = '';
      playerInstanceRef.current = window.AsciinemaPlayer.create(source, playerContainer, {
        autoplay: true,
        preload: true,
        fit: 'width',
      });
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4"
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
        className="w-full max-w-4xl rounded-2xl border border-slate-700 bg-slate-950 p-4 shadow-2xl sm:p-6"
        tabIndex={-1}
      >
        <div className="mb-4 flex items-center justify-between">
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

        <div className="max-h-[70vh] overflow-auto rounded-xl border border-slate-800 bg-black p-2 sm:p-3">
          <div ref={playerContainerRef} className="asciinema-player-wrapper min-h-[240px] w-full sm:min-h-[320px]" />
        </div>
      </div>
    </div>
  );
}
