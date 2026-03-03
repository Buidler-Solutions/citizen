'use client';

import { useEffect, useMemo, useState } from 'react';

const DESKTOP_FRAMES = 640;

type UseResponsiveFrameSetOptions = {
  preferredDesktopFrameCount?: number;
  frameAssetByNumber?: Record<number, string>;
};

export function useResponsiveFrameSet({ preferredDesktopFrameCount, frameAssetByNumber = {} }: UseResponsiveFrameSetOptions = {}) {
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
        const assetBaseUrl = process.env.NEXT_PUBLIC_ASSET_BASE_URL?.replace(/\/$/, '') ?? '';

        if (!isMobile) {
          const mappedFilename = frameAssetByNumber[frame] ?? frameAssetByNumber[frame + 1];
          if (mappedFilename) {
            if (/^https?:\/\//.test(mappedFilename)) {
              return mappedFilename;
            }

            const normalized = mappedFilename.startsWith('/') ? mappedFilename : `/${mappedFilename}`;
            return `${assetBaseUrl}${normalized}`;
          }
        }

        const padded = frame.toString().padStart(4, '0');
        const folder = isMobile ? '/frames/mobile' : '/frames/desktop';
        return `${assetBaseUrl}${folder}/frame-${padded}.webp`;
      },
    }),
    [desktopFrameCount, frameAssetByNumber, isMobile, mobileFrameCount],
  );
}
