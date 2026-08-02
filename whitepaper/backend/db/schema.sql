CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS whitepaper_sections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  start_frame INTEGER NOT NULL CHECK (start_frame >= 0),
  end_frame INTEGER NOT NULL CHECK (end_frame >= start_frame),
  order_index INTEGER NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS media_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename TEXT NOT NULL,
  frame_number INTEGER NOT NULL CHECK (frame_number >= 0),
  chapter_id UUID NOT NULL REFERENCES whitepaper_sections(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE(chapter_id, frame_number)
);

CREATE INDEX IF NOT EXISTS idx_whitepaper_sections_order_index ON whitepaper_sections(order_index);
CREATE INDEX IF NOT EXISTS idx_whitepaper_sections_frame_bounds ON whitepaper_sections(start_frame, end_frame);
CREATE INDEX IF NOT EXISTS idx_media_assets_frame_number ON media_assets(frame_number);
CREATE INDEX IF NOT EXISTS idx_media_assets_chapter_id ON media_assets(chapter_id);

ALTER TABLE whitepaper_sections
  ADD COLUMN IF NOT EXISTS content TEXT NOT NULL DEFAULT '';
