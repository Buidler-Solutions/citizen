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

This rollout keeps the existing GSAP + canvas scroll animation architecture unchanged while moving content ownership to a governed backend workflow (NestJS + PostgreSQL + admin console).

### 1) Target Architecture (Production)

```text
Admin Console (Next.js) ──JWT──> NestJS Admin API ──> PostgreSQL
                                     │
Public Whitepaper Frontend ─HTTP─────┤
                                     └──> CDN/Object Storage (frame images)
```

- **NestJS + PostgreSQL** is the source of truth for chapters, frame metadata, publish states, and audit logs.
- **Object storage/CDN** serves frame image files; DB stores canonical paths and sequencing metadata.
- **Public whitepaper frontend** only reads `published` content and keeps the same scroll-scrub animation runtime.

### 2) Data Model Rollout (Draft/Publish Safe)

Add explicit publishing state and version grouping:

- `whitepaper_releases` (id, label, status: `draft|published|archived`, published_at)
- `whitepaper_sections` linked to release_id
- `whitepaper_frames` linked to release_id + section_id
- `whitepaper_audit_log` (actor, action, entity_type, entity_id, before_json, after_json, created_at)

Constraints:

- `start_frame <= end_frame`
- unique `order_index` per release
- unique `(release_id, frame_number)`
- optional exclusion constraint to prevent overlapping ranges inside the same release

### 3) Backend API Contract

Keep public read APIs, but make them release-aware:

- `GET /whitepaper/metadata` -> active published release + frame bounds
- `GET /whitepaper/sections` -> sections for published release (sorted)
- `GET /whitepaper/frames?page=1&limit=50` -> paginated frames for published release

Admin APIs (JWT + `admin` role):

- `POST /admin/whitepaper/releases`
- `POST /admin/whitepaper/releases/:id/publish` (transactional: one active published release)
- `POST /admin/whitepaper/sections`
- `PATCH /admin/whitepaper/sections/:id`
- `DELETE /admin/whitepaper/sections/:id`
- `POST /admin/whitepaper/frames`
- `POST /admin/whitepaper/frames/bulk`
- `DELETE /admin/whitepaper/frames/:id`

Operational rules:

- publish endpoint invalidates read caches (`sections`, `frames`, `metadata`)
- bulk frame import validates continuity (`1..N` or approved gaps)
- all writes create immutable audit-log events

### 4) Admin Console Scope

Deliver an admin surface purpose-built for editorial control:

- release management (create draft, clone previous release, publish)
- section editor (title/body/frame-range/order)
- frame manager (single + CSV/JSON bulk import, missing-frame detection)
- preview mode using draft release data without affecting public site
- validation dashboard (range overlaps, duplicate frame numbers, ordering issues)

### 5) Frontend Integration (Animation Preservation Rules)

Non-negotiable compatibility rules:

- keep **GSAP ScrollTrigger timeline math unchanged**
- keep **canvas renderer contract unchanged** (`progress -> frameIndex -> image URL`)
- only replace static chapter/frame config with API-driven metadata

Integration steps:

1. fetch `metadata` at boot and set `totalFrames`
2. fetch `sections` and map to chapter overlays
3. resolve frame URLs via `ASSET_BASE_URL + frame.path`
4. preserve preloading strategy (first frame eager, remainder idle/batched)

### 6) Concrete Rollout Timeline

#### Sprint 1 - Foundation (Backend + DB)
- add release/audit schema via migrations
- wire Nest module services for release-scoped queries
- expose release-aware public read endpoints

Exit criteria:
- public site can read a seeded published release end-to-end

#### Sprint 2 - Admin API + Security
- implement admin CRUD + publish endpoint
- add JWT auth, role guards, and write rate limits
- add structured audit logging middleware/interceptor

Exit criteria:
- admin can create draft content and publish safely with full audit trail

#### Sprint 3 - Admin Console
- build release/section/frame management UI
- add bulk upload + validation surfaces
- add draft preview endpoint and preview mode toggle

Exit criteria:
- non-developer operator can manage full whitepaper lifecycle

#### Sprint 4 - Frontend Data Migration
- switch frontend to API-driven metadata/sections
- preserve scroll performance and frame determinism
- add fallback behavior for API outages (last known metadata)

Exit criteria:
- visual/parity check confirms identical animation behavior vs baseline

#### Sprint 5 - Hardening + Launch
- add integration/e2e tests for publish flow and read APIs
- add cache invalidation + warmup job on publish
- production deploy + monitoring dashboards/alerts

Exit criteria:
- SLOs met and launch checklist completed

### 7) Launch Checklist

- DB migrations applied and reversible
- at least one validated published release exists
- CDN cache headers tuned for frame assets
- admin JWT rotation policy documented
- alerting enabled for API latency/error rate
- runbook includes rollback to prior published release

### 8) Environment Variables (.env)

Backend:

- `DATABASE_URL`
- `JWT_SECRET`
- `ADMIN_JWT_AUDIENCE`
- `CORS_ORIGIN`
- `ASSET_BASE_URL`
- `CACHE_TTL_SECONDS`
- `PORT`

Frontend:

- `NEXT_PUBLIC_WHITEPAPER_API_BASE_URL`
- `NEXT_PUBLIC_ASSET_BASE_URL`

Sample files and bootstrap credentials:

- `backend/.env.example`
- `frontend/.env.example`
- `admin-console.sample-credentials.md`
