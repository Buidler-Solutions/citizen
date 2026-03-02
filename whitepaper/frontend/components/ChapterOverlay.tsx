'use client';

import { Chapter } from '@/lib/chapters';

type ChapterOverlayProps = {
  chapter: Chapter | null;
  chapterProgress: number;
};

export function ChapterOverlay({ chapter, chapterProgress }: ChapterOverlayProps) {
  if (!chapter) {
    return null;
  }

  const opacity = Math.min(1, Math.max(0, Math.sin(chapterProgress * Math.PI)));
  const translateY = 16 - opacity * 16;

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-20 mx-auto max-w-4xl px-6 pt-20 text-white"
      style={{ opacity, transform: `translate3d(0, ${translateY}px, 0)` }}
    >
      <p className="mb-2 text-xs uppercase tracking-[0.2em] text-cyan-300/90">Chapter {chapter.orderIndex}</p>
      <h2 className="mb-3 text-2xl font-semibold md:text-4xl">{chapter.title}</h2>
      <p className="max-w-2xl text-sm text-slate-200 md:text-base">{chapter.description}</p>
    </div>
  );
}
