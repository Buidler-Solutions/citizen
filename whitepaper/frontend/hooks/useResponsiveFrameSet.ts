'use client';

import { useEffect, useMemo, useState } from 'react';

const DESKTOP_FRAMES = 640;

type UseResponsiveFrameSetOptions = {
  preferredDesktopFrameCount?: number;
};

export function useResponsiveFrameSet({ preferredDesktopFrameCount }: UseResponsiveFrameSetOptions = {}) {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 767px)');
    const syncMobile = () => setIsMobile(mediaQuery.matches);

    syncMobile();
    mediaQuery.addEventListener('change', syncMobile);

    return () => mediaQuery.removeEventListener('change', syncMobile);
  }, []);

  const desktopFrameCount = preferredDesktopFrameCount && preferredDesktopFrameCount > 0
    ? preferredDesktopFrameCount
    : DESKTOP_FRAMES;

  const mobileFrameCount = Math.max(1, Math.floor(desktopFrameCount / 2));

  return useMemo(
    () => ({
      isMobile,
      totalFrames: isMobile ? mobileFrameCount : desktopFrameCount,
      framePath: (frame: number) => {
        const padded = frame.toString().padStart(4, '0');
        const assetBaseUrl = process.env.NEXT_PUBLIC_ASSET_BASE_URL?.replace(/\/$/, '') ?? '';
        const folder = isMobile ? '/frames/mobile' : '/frames/desktop';
        return `${assetBaseUrl}${folder}/frame-${padded}.webp`;
      },
    }),
    [desktopFrameCount, isMobile, mobileFrameCount],
  );
}
