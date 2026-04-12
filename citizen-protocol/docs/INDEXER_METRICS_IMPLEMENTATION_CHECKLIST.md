# Indexer Metrics Implementation Checklist (TPS + Block Weight + Entry Weight)

Status: implementation checklist for adding canonical analytics via an indexer while keeping protocol runtime deterministic and lean.
Last updated: 2026-04-12 (Checkpoint 2 revised to storage-engine-agnostic/non-relational contract).

## Goals

- [ ] Provide production-grade metrics for:
  - [ ] transactions/entries per second (TPS)
  - [ ] weight per block
  - [ ] weight per entry
- [ ] Keep node/runtime as canonical ledger source and indexer as derived analytics surface.
- [ ] Ensure explorer reads metrics from indexer APIs (not local UI heuristics).

---

## Checkpoint 0 — Definitions and contracts (must lock first)

- [x] Finalize canonical metric definitions:
  - [x] **TPS** = total committed entries in a fixed time window / window duration.
  - [x] **Block weight** = canonical serialized byte size of a block (define serialization format).
  - [x] **Entry weight** = canonical serialized byte size of an entry (same serialization family).
- [x] Publish definition doc with examples and edge cases:
  - [x] empty blocks,
  - [x] blocks with mixed entry types,
  - [x] privacy/encrypted payload entries,
  - [x] malformed historical payload fallback handling.
- [x] Decide and document rounding/precision:
  - [x] integer bytes for weights,
  - [x] decimal precision for TPS,
  - [x] stable ordering for deterministic recomputation.

Deliverable: signed-off metric-spec markdown in `citizen-protocol/docs/`.
Implementation artifact: `citizen-protocol/docs/INDEXER_METRICS_SPEC.md`.

---

## Checkpoint 1 — Event ingestion design

- [x] Define indexer input source:
  - [x] pull from canonical node API (`/blocks`, `/blocks/:height`) and replay forward.
  - [x] optional future direct event stream path.
- [x] Define cursor/replay strategy:
  - [x] persistent last-indexed height,
  - [x] safe restart from cursor,
  - [x] replay idempotency guarantees.
- [x] Handle canonical chain continuity checks:
  - [x] `prev_hash` continuity validation,
  - [x] policy for gap detection and recovery.
- [x] Define reorg/consistency policy (if applicable to environment).

Deliverable: ingestion architecture note + replay state machine diagram.
Implementation artifact: `citizen-protocol/docs/INDEXER_METRICS_INGESTION_ARCHITECTURE_NOTE.md`.

---

## Checkpoint 2 — Data model and storage schema

- [x] Create core entities/collections:
  - [x] `indexed_blocks` (height, hash/entry_root, proposer, timestamp, entry_count, block_weight_bytes)
  - [x] `indexed_entries` (entry_id, block_height, namespace, action, timestamp, entry_weight_bytes)
  - [x] `metric_windows` (window_name, window_start, window_end, tps, entries_committed)
- [x] Add lookup/index strategy for query workloads:
  - [x] by `block_height`,
  - [x] by `timestamp`,
  - [x] by `namespace`,
  - [x] by `entry_id`.
- [x] Add uniqueness constraints to ensure idempotent writes.
- [x] Add migration/versioning strategy for storage evolution.

Deliverable: storage manifests/migrations + schema documentation.
Implementation artifact: `citizen-protocol/docs/INDEXER_METRICS_DATA_MODEL_AND_SCHEMA.md` (storage-engine-agnostic schema contract complete; backend adapter/manifests pending implementation).

---

## Checkpoint 3 — Canonical weight computation module

- [ ] Implement shared weight computation library:
  - [ ] `compute_entry_weight(entry) -> u64`
  - [ ] `compute_block_weight(block) -> u64`
- [ ] Use one canonical serialization strategy across all calculations.
- [ ] Add deterministic test vectors:
  - [ ] same input -> same bytes/weights,
  - [ ] cross-process reproducibility,
  - [ ] boundary tests (empty payload, large payload, selective encrypted fields).
- [ ] Add regression fixtures from real sample blocks.

Deliverable: tested weight module + fixtures committed in repo.

---

## Checkpoint 4 — Indexer pipeline implementation

- [ ] Implement block fetch loop:
  - [ ] startup catch-up from cursor to latest,
  - [ ] steady-state polling for new heights,
  - [ ] backoff/retry policy.
- [ ] For each block:
  - [ ] verify continuity,
  - [ ] compute/store block weight,
  - [ ] compute/store each entry weight,
  - [ ] persist atomically in one transaction.
- [ ] Ensure idempotent upsert behavior for repeated fetches.
- [ ] Add poison-block handling and operator visibility.

Deliverable: runnable indexer worker with structured logs.

---

## Checkpoint 5 — TPS/window aggregation

- [ ] Define supported windows:
  - [ ] 10s,
  - [ ] 60s,
  - [ ] 5m,
  - [ ] 1h.
- [ ] Implement window rollups:
  - [ ] per-window `entries_committed`,
  - [ ] derived `tps`,
  - [ ] gap-safe bucket boundaries.
- [ ] Add late-data handling policy (if delayed ingestion occurs).
- [ ] Add periodic compaction/retention jobs.

Deliverable: deterministic aggregation jobs + test coverage.

---

## Checkpoint 6 — Metrics API surface (indexer service)

- [ ] Add API endpoints:
  - [ ] `GET /metrics/tps?window=60s&from=&to=`
  - [ ] `GET /metrics/blocks?from_height=&to_height=`
  - [ ] `GET /metrics/entries?namespace=&from=&to=`
  - [ ] `GET /metrics/summary` (latest snapshot)
- [ ] Define response schema with explicit units:
  - [ ] `*_bytes`,
  - [ ] `tps`,
  - [ ] timestamps in UTC.
- [ ] Add pagination/filtering for high-volume datasets.
- [ ] Add auth/rate-limit policy if needed for shared environments.

Deliverable: API contract doc + integration tests.

---

## Checkpoint 7 — Explorer integration

- [ ] Replace explorer dashboard heuristics with indexer metrics APIs:
  - [ ] TPS chart reads real TPS series,
  - [ ] block list uses real block weight,
  - [ ] entry views use real entry weight.
- [ ] Preserve fallback UX for local dev when indexer is unavailable.
- [ ] Add clear source labels (`runtime`, `indexer`, or `fallback`).
- [ ] Update explorer README and environment variables.

Deliverable: explorer dashboard wired to indexer metrics endpoints.

---

## Checkpoint 8 — Observability, SLOs, and operations

- [ ] Emit indexer internal metrics:
  - [ ] ingestion lag (`latest_runtime_height - indexed_height`),
  - [ ] block processing latency,
  - [ ] failed block count,
  - [ ] retry counts,
  - [ ] aggregation job latency.
- [ ] Define SLO targets:
  - [ ] freshness (e.g., p95 lag under N seconds),
  - [ ] API availability,
  - [ ] aggregation correctness checks.
- [ ] Add alerting playbooks for:
  - [ ] stalled cursor,
  - [ ] sustained lag,
  - [ ] checksum mismatches.

Deliverable: runbook + dashboards + alert definitions.

---

## Checkpoint 9 — Verification and backfill

- [ ] Backfill historical blocks from genesis/current baseline.
- [ ] Verify random sampled heights:
  - [ ] entry counts match runtime,
  - [ ] timestamps match runtime,
  - [ ] computed weights reproducible.
- [ ] Cross-check TPS windows against recomputation script.
- [ ] Produce evidence bundle (queries, outputs, checksums).

Deliverable: signed verification report.

---

## Checkpoint 10 — Rollout and governance alignment

- [ ] Stage rollout:
  - [ ] localnet,
  - [ ] shared dev/test environment,
  - [ ] production candidate.
- [ ] Add feature flag for explorer metric source switching.
- [ ] Document operator responsibilities and on-call procedures.
- [ ] Add release notes and architecture baseline updates.

Deliverable: rollout completion checklist + post-rollout review.

---

## Done criteria

- [ ] Metric definitions are stable, documented, and test-backed.
- [ ] Indexer can replay from cursor/genesis deterministically.
- [ ] APIs serve canonical TPS + weight metrics with explicit units.
- [ ] Explorer displays indexer-backed metrics in normal operation.
- [ ] Runbooks, alerts, and SLOs are in place.
