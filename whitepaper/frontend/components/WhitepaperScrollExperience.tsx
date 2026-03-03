'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { ChapterOverlay } from '@/components/ChapterOverlay';
import { useImageSequencePreloader } from '@/hooks/useImageSequencePreloader';
import { useResponsiveFrameSet } from '@/hooks/useResponsiveFrameSet';
import { useWhitepaperContent } from '@/hooks/useWhitepaperContent';

gsap.registerPlugin(ScrollTrigger);

const clampFrame = (frame: number, total: number) => Math.min(Math.max(frame, 0), total - 1);

export function WhitepaperScrollExperience() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [activeFrame, setActiveFrame] = useState(0);
  const { chapters, desktopFrameCount, frameAssetByNumber } = useWhitepaperContent();
  const { isMobile, totalFrames, framePath } = useResponsiveFrameSet({
    preferredDesktopFrameCount: desktopFrameCount,
    frameAssetByNumber,
  });
  const { isReady, getFrame } = useImageSequencePreloader({ totalFrames, framePath });

  const chapter = useMemo(
    () => chapters.find((item) => activeFrame >= item.startFrame && activeFrame <= item.endFrame) ?? null,
    [activeFrame, chapters],
  );

  const chapterProgress = useMemo(() => {
    if (!chapter) return 0;
    const length = chapter.endFrame - chapter.startFrame + 1;
    return (activeFrame - chapter.startFrame) / Math.max(1, length - 1);
  }, [activeFrame, chapter]);

  useEffect(() => {
    if (!isReady || !containerRef.current || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return;

    let rafId = 0;
    const frameState = { frame: 0 };

    const drawFrame = (frameIndex: number) => {
      const image = getFrame(frameIndex) ?? getFrame(0);
      if (!image) return;

      const { width, height } = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;

      const targetWidth = Math.floor(width * dpr);
      const targetHeight = Math.floor(height * dpr);

      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
      }

      const imageAspect = image.naturalWidth / Math.max(1, image.naturalHeight);
      const canvasAspect = targetWidth / Math.max(1, targetHeight);

      let renderWidth = targetWidth;
      let renderHeight = targetHeight;

      if (imageAspect > canvasAspect) {
        renderHeight = targetHeight;
        renderWidth = targetHeight * imageAspect;
      } else {
        renderWidth = targetWidth;
        renderHeight = targetWidth / imageAspect;
      }

      const dx = (targetWidth - renderWidth) / 2;
      const dy = (targetHeight - renderHeight) / 2;

      context.clearRect(0, 0, targetWidth, targetHeight);
      context.drawImage(image, dx, dy, renderWidth, renderHeight);
    };

    const requestDraw = (frameIndex: number) => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        drawFrame(frameIndex);
        setActiveFrame(frameIndex);
      });
    };

    requestDraw(0);

    const trigger = ScrollTrigger.create({
      trigger: containerRef.current,
      start: 'top top',
      end: `+=${isMobile ? 5000 : 8000}`,
      scrub: true,
      pin: true,
      onUpdate: (self) => {
        const frameIndex = clampFrame(Math.floor(self.progress * totalFrames), totalFrames);
        if (frameIndex !== frameState.frame) {
          frameState.frame = frameIndex;
          requestDraw(frameIndex);
        }
      },
    });

    const onResize = () => requestDraw(frameState.frame);
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
      trigger.kill();
    };
  }, [getFrame, isMobile, isReady, totalFrames]);

  return (
    <section className="bg-[#030712]">
      <div ref={containerRef} className="relative h-screen w-full overflow-hidden">
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-label="Citizen whitepaper sequence" />
        <div className="absolute inset-0 bg-gradient-to-t from-[#030712] via-transparent to-black/20" />
        <ChapterOverlay chapter={chapter} chapterProgress={chapterProgress} />
      </div>
    </section>
  );
}
