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

## Implementation Plan: Nest Hosting + Admin-Controlled Whitepaper Content

This plan keeps the existing scroll animation system intact while moving chapter/frame content control into a NestJS + PostgreSQL admin workflow.

### 1) Deploy Topology

- Host **NestJS API** and **PostgreSQL** as the system of record for whitepaper sections and frame metadata.
- Host the **Next.js whitepaper frontend** separately (or behind the same gateway) and fetch content from the Nest API.
- Keep frame images in object storage/CDN (S3, R2, or equivalent) and store normalized file metadata in PostgreSQL.

### 2) Backend API Expansion (Admin CRUD)

Keep existing public read routes and add authenticated admin routes:

- `POST /admin/whitepaper/sections`
- `PATCH /admin/whitepaper/sections/:id`
- `DELETE /admin/whitepaper/sections/:id`
- `POST /admin/whitepaper/frames` (single)
- `POST /admin/whitepaper/frames/bulk` (batch import)
- `DELETE /admin/whitepaper/frames/:id`

Validation constraints to enforce server-side:

- `start_frame <= end_frame`
- no overlapping chapter frame ranges unless explicitly allowed
- `order_index` uniqueness
- frame number uniqueness per chapter (already modeled in schema)

### 3) Admin Console Responsibilities

Build or integrate an admin UI that allows:

- chapter create/edit/reorder
- frame assignment and batch upload management
- publish flow (draft -> published flag)
- metadata preview (frame ranges, chapter boundaries, ordering)

Recommended pattern:

- admin writes to `draft` records
- explicit `publish` action atomically promotes content to live
- frontend reads only `published` records

### 4) Frontend Integration (Preserve Scroll Animation)

To maintain the scroll animation system:

- keep GSAP ScrollTrigger + canvas renderer unchanged
- replace hard-coded chapter source with API-fetched chapter data
- derive `totalFrames` and chapter boundaries from metadata/sections API
- preserve deterministic frame URL mapping for smooth scrub behavior

### 5) Environment Variables (.env)

Use `.env` for local/dev and secret management in production.

Suggested Nest variables:

- `DATABASE_URL`
- `JWT_SECRET`
- `ADMIN_JWT_AUDIENCE`
- `CORS_ORIGIN`
- `ASSET_BASE_URL`
- `PORT`

Suggested frontend variables:

- `NEXT_PUBLIC_WHITEPAPER_API_BASE_URL`
- `NEXT_PUBLIC_ASSET_BASE_URL`

### 6) Security & Operations

- protect admin routes with JWT + role-based guard (`admin` role)
- enable audit logging for all content mutations
- rate-limit write routes and validate payload size for bulk uploads
- use DB migrations for schema evolution
- add cache invalidation on publish to keep read APIs fresh

### 7) Delivery Phases

1. **Phase A:** wire TypeORM + PostgreSQL + existing read endpoints in your Nest host app.
2. **Phase B:** add admin CRUD endpoints + auth/roles.
3. **Phase C:** build admin UI and publish workflow.
4. **Phase D:** migrate frontend from static chapters to API-driven chapters.
5. **Phase E:** harden with tests, audit logs, and cache invalidation.
