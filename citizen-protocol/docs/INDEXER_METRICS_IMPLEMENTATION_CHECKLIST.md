# Indexer Metrics Implementation Checklist (TPS + Block Weight + Entry Weight)

Status: implementation checklist for adding canonical analytics via an indexer while keeping protocol runtime deterministic and lean.
Last updated: 2026-04-12 (Checkpoint 10 rollout staging + on-call runbook now implemented with deployment-profile policy defaults and release-note checklist artifacts).

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

- [x] Publish implementation-ready module contract and fixture/test plan.
- [x] Implement shared weight computation library:
  - [x] `compute_entry_weight(entry) -> u64`
  - [x] `compute_block_weight(block) -> u64`
- [x] Use one canonical serialization strategy across all calculations.
- [x] Add deterministic test vectors:
  - [x] same input -> same bytes/weights,
  - [x] cross-process reproducibility,
  - [x] boundary tests (empty payload, large payload, selective encrypted fields).
- [x] Add regression fixtures from real sample blocks.

Deliverable: tested weight module + fixtures committed in repo.
Implementation artifact: `citizen-protocol/docs/INDEXER_METRICS_WEIGHT_COMPUTATION_MODULE.md` (module boundary, serializer contract, fixture taxonomy, and test matrix documented).

---

## Checkpoint 4 — Indexer pipeline implementation

- [x] Implement block fetch loop:
  - [x] startup catch-up from cursor to latest,
  - [x] steady-state polling for new heights,
  - [x] backoff/retry policy.
- [x] For each block:
  - [x] verify continuity,
  - [x] compute/store block weight,
  - [x] compute/store each entry weight,
  - [x] persist atomically in one transaction.
- [x] Ensure idempotent upsert behavior for repeated fetches.
- [x] Add poison-block handling and operator visibility.

Deliverable: runnable indexer worker with structured logs.
Implementation artifact: `explorer/backend/src/indexer/indexer-metrics.service.ts`.

---

## Checkpoint 5 — TPS/window aggregation

- [x] Define supported windows:
  - [x] 10s,
  - [x] 60s,
  - [x] 5m,
  - [x] 1h.
- [x] Implement window rollups:
  - [x] per-window `entries_committed`,
  - [x] derived `tps`,
  - [x] gap-safe bucket boundaries.
- [x] Add late-data handling policy (if delayed ingestion occurs).
- [x] Add periodic compaction/retention jobs.

Deliverable: deterministic aggregation jobs + test coverage.
Implementation artifact: `explorer/backend/src/indexer/indexer-metrics.service.ts` (`recomputeWindows`).

---

## Checkpoint 6 — Metrics API surface (indexer service)

- [x] Add API endpoints:
  - [x] `GET /metrics/tps?window=60s&from=&to=`
  - [x] `GET /metrics/blocks?from_height=&to_height=`
  - [x] `GET /metrics/entries?namespace=&from=&to=`
  - [x] `GET /metrics/summary` (latest snapshot)
- [x] Define response schema with explicit units:
  - [x] `*_bytes`,
  - [x] `tps`,
  - [x] timestamps in UTC.
- [x] Add pagination/filtering for high-volume datasets.
- [x] Add auth/rate-limit policy if needed for shared environments.

Deliverable: API contract doc + integration tests.
Implementation artifact: `explorer/backend/src/app.controller.ts` + `explorer/backend/src/indexer/metrics.types.ts`.

---

## Checkpoint 7 — Explorer integration

- [x] Replace explorer dashboard heuristics with indexer metrics APIs:
  - [x] TPS chart reads real TPS series,
  - [x] block list uses real block weight,
  - [x] entry views use real entry weight.
- [x] Preserve fallback UX for local dev when indexer is unavailable.
- [x] Add clear source labels (`runtime`, `indexer`, or `fallback`).
- [x] Update explorer README and environment variables.

Deliverable: explorer dashboard wired to indexer metrics endpoints.

---

## Checkpoint 8 — Observability, SLOs, and operations

- [x] Emit indexer internal metrics:
  - [x] ingestion lag (`latest_runtime_height - indexed_height`),
  - [x] block processing latency,
  - [x] failed block count,
  - [x] retry counts,
  - [x] aggregation job latency.
- [x] Define SLO targets:
  - [x] freshness (lag-block SLO in summary snapshot),
  - [x] API availability (successful fetch ratio proxy),
  - [x] aggregation correctness checks (checksum mismatch proxy).
- [x] Add alerting playbooks for:
  - [x] stalled cursor,
  - [x] sustained lag,
  - [x] checksum mismatches.

Deliverable: runbook + dashboards + alert definitions.

---

## Checkpoint 9 — Verification and backfill

- [x] Backfill historical blocks from genesis/current baseline.
- [x] Verify random sampled heights:
  - [x] entry counts match runtime,
  - [x] timestamps match runtime,
  - [x] computed weights reproducible.
- [x] Cross-check TPS windows against recomputation script.
- [x] Produce evidence bundle (queries, outputs, checksums).

Deliverable: signed verification report.
Implementation artifact: `explorer/backend/src/app.controller.ts` + `explorer/backend/src/indexer/indexer-metrics.service.ts` + `explorer/backend/src/indexer/metrics.types.ts`.

---

## Checkpoint 10 — Rollout and governance alignment

- [ ] Stage rollout:
  - [x] localnet,
  - [x] shared dev/test environment,
  - [x] production candidate.
- [x] Add feature flag for explorer metric source switching.
- [x] Document operator responsibilities and on-call procedures.
- [x] Add release notes and architecture baseline updates.

Deliverable: rollout completion checklist + post-rollout review.
Implementation artifacts:
- `citizen-protocol/docs/INDEXER_METRICS_ROLLOUT_COMPLETION.md`
- `citizen-protocol/docs/DEEP_RESEARCH_ARCHITECTURE_BASELINE.md`
- `explorer/backend/src/indexer/metrics-access.service.ts`
- `explorer/backend/src/indexer/indexer-metrics.service.ts`
- `explorer/backend/src/indexer/metrics.types.ts`

---

## Done criteria

- [ ] Metric definitions are stable, documented, and test-backed.
- [ ] Indexer can replay from cursor/genesis deterministically.
- [ ] APIs serve canonical TPS + weight metrics with explicit units.
- [ ] Explorer displays indexer-backed metrics in normal operation.
- [ ] Runbooks, alerts, and SLOs are in place.
