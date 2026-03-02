'use client';

import { useEffect, useRef, useState } from 'react';

type UseImageSequencePreloaderParams = {
  totalFrames: number;
  framePath: (frame: number) => string;
};

export function useImageSequencePreloader({ totalFrames, framePath }: UseImageSequencePreloaderParams) {
  const [isReady, setIsReady] = useState(false);
  const imagesRef = useRef<(HTMLImageElement | undefined)[]>([]);

  useEffect(() => {
    let mounted = true;
    imagesRef.current = Array.from({ length: totalFrames });

    const first = new Image();
    first.src = framePath(0);

    first.decode()
      .then(() => {
        if (!mounted) return;
        imagesRef.current[0] = first;
        setIsReady(true);
      })
      .catch(() => {
        if (!mounted) return;
        imagesRef.current[0] = first;
        setIsReady(true);
      });

    const preloadBatch = (startIndex: number, batchSize = 12) => {
      const endIndex = Math.min(totalFrames, startIndex + batchSize);

      for (let i = startIndex; i < endIndex; i += 1) {
        const image = new Image();
        image.src = framePath(i);
        imagesRef.current[i] = image;
      }

      if (endIndex < totalFrames) {
        requestIdleCallback(() => preloadBatch(endIndex, batchSize));
      }
    };

    requestIdleCallback(() => preloadBatch(1));

    return () => {
      mounted = false;
    };
  }, [framePath, totalFrames]);

  return {
    isReady,
    getFrame: (index: number) => imagesRef.current[index],
  };
}
