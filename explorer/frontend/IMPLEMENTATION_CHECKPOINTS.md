# Explorer Frontend Implementation Checkpoints

This checklist tracks frontend milestones that derive directly from Citizen node runtime data surfaced through the explorer backend.

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
- [ ] Add a blocks list route/page (for example `/blocks`) as the primary chain exploration surface.
- [ ] Add a block details route/page (for example `/blocks/[height]`).
- [ ] Every rendered block list item is keyboard-focusable and clickable, navigating to the corresponding detail route.
- [ ] Deep links to block detail routes load directly on refresh (SSR/server component safe).

### UX/UI checkpoints ("stunning" and readable)
- [ ] Use a clear visual hierarchy (height, proposer, timestamp, entry count, short hashes).
- [ ] Use compact hash formatting with copy affordances for full values in detail view.
- [ ] Add tasteful motion/hover states for block cards without reducing readability/performance.
- [ ] Ensure color contrast and typography are accessible in both normal and dense lists.
- [ ] Provide loading skeletons for first page and next-page fetches.
- [ ] Provide explicit empty state (no blocks) and degraded state (node unreachable).

### Pagination interaction checkpoints
- [ ] Support forward pagination (`Load more` or infinite scroll with guardrails).
- [ ] Preserve scroll position and already loaded pages when navigating back from block detail.
- [ ] Prevent duplicate blocks when paginating.
- [ ] Disable/guard repeated fetch triggers while a page request is in flight.

### Block detail checkpoints
- [ ] Detail page renders full block header values and entries payload summary from runtime data.
- [ ] Add navigation affordances: back to list, previous block, next block (when available).
- [ ] Show canonical source label (backend + node source) for operator trust/debugging.
- [ ] Handle missing height cleanly (`Block not found` state).

### Quality checkpoints
- [ ] Unit tests for block list item rendering/formatting helpers.
- [ ] Integration test for list → detail navigation using real route params.
- [ ] Pagination test that validates stable ordering and no duplicates.
- [ ] Manual responsive review for common breakpoints (mobile, tablet, desktop).

### Definition of done
- [ ] A user can open `/blocks`, scan a paginated and visually polished list of recent blocks, click any block, and inspect complete details without losing list context.
