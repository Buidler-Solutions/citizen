'use client';

import { useEffect, useMemo, useState } from 'react';
import { CHAPTERS, Chapter } from '@/lib/chapters';

type WhitepaperMetadataResponse = {
  data?: {
    frameCount?: number;
  };
};

type WhitepaperSectionsResponse = {
  data?: Chapter[];
};

type WhitepaperFrameAsset = {
  frameNumber: number;
  filename: string;
};

type WhitepaperFramesResponse = {
  data?: WhitepaperFrameAsset[];
  meta?: {
    hasNextPage?: boolean;
  };
};

const DEFAULT_FRAME_COUNT = 640;

const asValidChapters = (candidate: unknown): Chapter[] | null => {
  if (!Array.isArray(candidate)) {
    return null;
  }

  const chapters = candidate.filter((item): item is Chapter => {
    if (!item || typeof item !== 'object') return false;

    const chapter = item as Partial<Chapter>;
    return (
      typeof chapter.id === 'string' &&
      typeof chapter.title === 'string' &&
      typeof chapter.description === 'string' &&
      typeof chapter.startFrame === 'number' &&
      typeof chapter.endFrame === 'number' &&
      typeof chapter.orderIndex === 'number'
    );
  });

  return chapters.length > 0 ? chapters.sort((a, b) => a.orderIndex - b.orderIndex) : null;
};

export function useWhitepaperContent() {
  const [chapters, setChapters] = useState<Chapter[]>(CHAPTERS);
  const [desktopFrameCount, setDesktopFrameCount] = useState(DEFAULT_FRAME_COUNT);
  const [frameAssetByNumber, setFrameAssetByNumber] = useState<Record<number, string>>({});

  useEffect(() => {
    const apiBaseUrl = process.env.NEXT_PUBLIC_WHITEPAPER_API_BASE_URL;
    if (!apiBaseUrl) return;

    const abortController = new AbortController();

    const syncContent = async () => {
      try {
        const [metadataResponse, sectionsResponse] = await Promise.all([
          fetch(`${apiBaseUrl}/whitepaper/metadata`, { signal: abortController.signal }),
          fetch(`${apiBaseUrl}/whitepaper/sections`, { signal: abortController.signal }),
        ]);

        if (metadataResponse.ok) {
          const metadata = (await metadataResponse.json()) as WhitepaperMetadataResponse;
          if (metadata.data?.frameCount && metadata.data.frameCount > 0) {
            setDesktopFrameCount(metadata.data.frameCount);
          }
        }

        if (sectionsResponse.ok) {
          const sections = (await sectionsResponse.json()) as WhitepaperSectionsResponse;
          const nextChapters = asValidChapters(sections.data);
          if (nextChapters) {
            setChapters(nextChapters);
          }
        }

        const frameLookup: Record<number, string> = {};
        let page = 1;
        let hasNextPage = true;

        while (hasNextPage && !abortController.signal.aborted) {
          const framesResponse = await fetch(`${apiBaseUrl}/whitepaper/frames?page=${page}&limit=200`, {
            signal: abortController.signal,
          });

          if (!framesResponse.ok) {
            break;
          }

          const framesPayload = (await framesResponse.json()) as WhitepaperFramesResponse;
          const frameRows = Array.isArray(framesPayload.data) ? framesPayload.data : [];

          frameRows.forEach((frame) => {
            if (typeof frame.frameNumber === 'number' && typeof frame.filename === 'string') {
              frameLookup[frame.frameNumber] = frame.filename;
            }
          });

          hasNextPage = Boolean(framesPayload.meta?.hasNextPage);
          page += 1;
        }

        if (Object.keys(frameLookup).length > 0) {
          setFrameAssetByNumber(frameLookup);
        }
      } catch {
        // fallback to static content when API is unavailable
      }
    };

    void syncContent();

    return () => {
      abortController.abort();
    };
  }, []);

  return useMemo(
    () => ({
      chapters,
      desktopFrameCount,
      frameAssetByNumber,
    }),
    [chapters, desktopFrameCount, frameAssetByNumber],
  );
}
