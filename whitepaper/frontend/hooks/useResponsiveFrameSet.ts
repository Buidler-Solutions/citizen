'use client';

import { useEffect, useMemo, useState } from 'react';

const DESKTOP_FRAMES = 640;
const MOBILE_FRAMES = 320;

export function useResponsiveFrameSet() {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 767px)');
    const syncMobile = () => setIsMobile(mediaQuery.matches);

    syncMobile();
    mediaQuery.addEventListener('change', syncMobile);

    return () => mediaQuery.removeEventListener('change', syncMobile);
  }, []);

  return useMemo(
    () => ({
      isMobile,
      totalFrames: isMobile ? MOBILE_FRAMES : DESKTOP_FRAMES,
      framePath: (frame: number) => {
        const padded = frame.toString().padStart(4, '0');
        const folder = isMobile ? '/frames/mobile' : '/frames/desktop';
        return `${folder}/frame-${padded}.webp`;
      },
    }),
    [isMobile],
  );
}
