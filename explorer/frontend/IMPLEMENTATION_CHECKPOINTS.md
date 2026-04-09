# Explorer Frontend Implementation Checkpoints

This checklist tracks frontend milestones that derive directly from Citizen node runtime data surfaced through the explorer backend.

> Progress note (April 9, 2026): Initial `/blocks` and `/blocks/[height]` implementation is now in place in the frontend with backend-connected fetches and graceful fallback states.
>
> Progress note (April 9, 2026 — follow-up): Added route-level loading skeletons for list/detail, compact hash presentation with one-click copy controls in block detail, and improved text contrast/readability defaults in shared explorer styles.

> Progress note (April 9, 2026 — checkpoint sync): Verified in-repo frontend coverage now includes explicit empty/degraded list states, route-level skeletons, card-level click-through to detail, and source-aware detail rendering. Remaining checkpoint gaps are focused on backend pagination contract hardening and client-side list state retention when returning from detail navigation.

> Progress note (April 9, 2026 — client pagination/state): Migrated `/blocks` pagination to client-managed incremental loading with in-flight request guards, dedupe-by-height append logic, and session-backed list/scroll restoration when returning from block detail.

## Checkpoint 1 — Paginated Blocks Gallery (Clickable to Block Detail)

**Goal**
Build a technically robust and visually elegant blocks list experience where every block row/card is clickable and routes to a dedicated block detail page.

### Data contract checkpoints
- [ ] Backend exposes a paginated blocks endpoint consumed by the frontend (for example: `GET /blocks?cursor=<cursor>&limit=<n>`), with deterministic ordering by height descending.
- [ ] Response includes pagination metadata (`next_cursor` and/or `has_more`) so the UI can request the next page without guessing heights.
- [ ] Each block item includes enough runtime-derived fields to render a useful summary card:
  - [ ] `height`
  - [ ] `header.timestamp`
  - [ ] `header.proposer`
  - [ ] `header.prev_hash`
  - [ ] `header.entry_root`
  - [ ] `header.commit_proof.aggregated_signature`
  - [ ] entry count (derived from block entries array)
- [ ] API error states are explicit (`4xx`/`5xx` with message) so the frontend can render graceful user-facing states.

### Frontend routing checkpoints
- [x] Add a blocks list route/page (for example `/blocks`) as the primary chain exploration surface.
- [x] Add a block details route/page (for example `/blocks/[height]`).
- [x] Every rendered block list item is keyboard-focusable and clickable, navigating to the corresponding detail route.
- [x] Deep links to block detail routes load directly on refresh (SSR/server component safe).

### UX/UI checkpoints ("stunning" and readable)
- [x] Use a clear visual hierarchy (height, proposer, timestamp, entry count, short hashes).
- [x] Use compact hash formatting with copy affordances for full values in detail view.
- [x] Add tasteful motion/hover states for block cards without reducing readability/performance.
- [x] Ensure color contrast and typography are accessible in both normal and dense lists.
- [x] Provide loading skeletons for first page and next-page fetches.
- [x] Provide explicit empty state (no blocks) and degraded state (node unreachable).

### Pagination interaction checkpoints
- [x] Support forward pagination (`Load more` or infinite scroll with guardrails).
- [x] Preserve scroll position and already loaded pages when navigating back from block detail.
- [x] Prevent duplicate blocks when paginating.
- [x] Disable/guard repeated fetch triggers while a page request is in flight.

### Block detail checkpoints
- [x] Detail page renders full block header values and entries payload summary from runtime data.
- [x] Add navigation affordances: back to list, previous block, next block (when available).
- [x] Show canonical source label (backend + node source) for operator trust/debugging.
- [x] Handle missing height cleanly (`Block not found` state).

### Quality checkpoints
- [ ] Unit tests for block list item rendering/formatting helpers.
- [ ] Integration test for list → detail navigation using real route params.
- [ ] Pagination test that validates stable ordering and no duplicates.
- [ ] Manual responsive review for common breakpoints (mobile, tablet, desktop).

### Active implementation next-up (Checkpoint 1 completion track)
- [ ] Add/verify explorer backend paginated `GET /blocks` endpoint contract (`items`, `next_cursor`, `has_more`) so frontend pagination is backed by a stable runtime source instead of placeholder assumptions.
- [x] Move blocks list pagination to a client-state flow that appends pages in-place and avoids full-page cursor transitions.
- [x] Persist list state (`loaded heights`, `next_cursor`, `scroll position`) across list -> detail -> list navigation to preserve operator context.
- [x] Add in-flight guards + dedupe-by-height logic in pagination append path to satisfy no-duplicate and repeated-trigger checkpoints.
- [ ] Backfill focused tests for formatting helpers and list/detail navigation behavior.

### Definition of done
- [ ] A user can open `/blocks`, scan a paginated and visually polished list of recent blocks, click any block, and inspect complete details without losing list context.
