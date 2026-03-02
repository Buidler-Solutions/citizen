# Citizen Protocol Whitepaper Website

Production-ready blueprint for a scroll-scrubbed whitepaper experience with a Next.js frontend and NestJS/PostgreSQL backend.

## Architecture

- `frontend/`: Next.js App Router + TypeScript + GSAP ScrollTrigger + canvas image-sequence renderer.
- `backend/`: NestJS whitepaper module serving sections, frames, and metadata from PostgreSQL.
- `backend/db/schema.sql`: SQL schema and indexes for sections and media assets.

## Frontend Highlights

- Canvas-only frame rendering (no `<video>` tag).
- Scroll direction support for both forward and rewind scrubbing.
- GSAP pinned timeline section with `progress -> frameIndex` mapping.
- Chapter overlay system mapped to frame ranges.
- Mobile adaptation (`<768px`): reduced frame count, shorter scroll distance, lighter effects.
- High-DPI rendering with responsive resize handling.
- Lazy image preloading strategy: first frame eagerly loaded, rest loaded in idle batches.

## Backend Highlights

- Endpoints:
  - `GET /whitepaper/sections`
  - `GET /whitepaper/frames?page=1&limit=50`
  - `GET /whitepaper/metadata`
- Structured JSON response envelopes (`data`, `meta`).
- Pagination support for frame assets.
- TypeORM entities with indexes for high-volume frame lookups.
- Caching via Nest Cache Interceptor + endpoint TTL.

## Run Notes

### Frontend

```bash
cd frontend
npm install
npm run dev
```

### Backend

Integrate `WhitepaperModule` into your Nest application root module and configure TypeORM for PostgreSQL.

Apply schema:

```bash
psql "$DATABASE_URL" -f backend/db/schema.sql
```
