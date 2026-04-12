# Indexer Metrics Data Model and Storage Schema (Checkpoint 2)

Status: storage-model design artifact for canonical indexer metrics persistence.
Last updated: 2026-04-12 (manifests + JSON snapshot adapter landed in explorer backend).

## Scope

This document defines a **storage-engine-agnostic** model for indexer metrics.

For Citizen, the indexer should follow blockchain-friendly operational constraints:

- keep canonical chain data in protocol/node storage,
- treat indexer storage as derived/rebuildable analytics state,
- avoid forcing relational SQL as the only backend.

## Design posture (non-relational first)

The indexer storage contract is expressed as logical entities + keys + secondary lookup requirements.

Recommended backend families:

- embedded key-value stores,
- LSM-style engines,
- document/column stores,
- object-store + compacted materialized views.

A relational backend is still technically possible, but **not required** by this contract.

## Logical entities

## `indexed_blocks`

One canonical record per committed block height.

Required fields:

- `block_height` (u64, primary key)
- `block_hash` (string/bytes, unique)
- `prev_hash` (optional string/bytes)
- `entry_root` (optional string/bytes)
- `proposer` (optional string)
- `committed_at` (UTC timestamp)
- `entry_count` (u32/u64)
- `block_weight_bytes` (u64)
- `first_seen_at` (UTC timestamp)
- `updated_at` (UTC timestamp)

Primary key:

- `blocks/{block_height}`

Uniqueness requirement:

- `block_hash` must be globally unique for idempotent replay safety.

## `indexed_entries`

One canonical record per committed entry.

Required fields:

- `entry_id` (string/bytes, primary key)
- `block_height` (u64)
- `entry_index` (u32)
- `namespace` (string)
- `action` (string)
- `committed_at` (UTC timestamp)
- `entry_weight_bytes` (u64)
- `signer` (optional string)
- `first_seen_at` (UTC timestamp)
- `updated_at` (UTC timestamp)

Primary key:

- `entries/{entry_id}`

Uniqueness requirements:

- `entry_id` unique globally.
- `(block_height, entry_index)` unique within chain history.

## `metric_windows`

Derived TPS snapshots for fixed windows.

Required fields:

- `window_name` (`10s` | `60s` | `5m` | `1h`)
- `window_start` (UTC timestamp)
- `window_end` (UTC timestamp)
- `entries_committed` (u64)
- `tps` (fixed decimal or rational representation)
- `computed_at` (UTC timestamp)

Primary key:

- `windows/{window_name}/{window_start}/{window_end}`

Invariant:

- `window_end > window_start`.

## Secondary indexes / materialized lookups

Backends must provide equivalent queryability for:

- blocks by `committed_at` (descending recency),
- entries by `block_height`,
- entries by `committed_at` (descending recency),
- entries by `(namespace, committed_at)` for namespace analytics,
- windows by `(window_name, window_start desc)`.

Implementation options:

- native secondary indexes,
- dedicated key-prefix projections,
- precomputed materialized views.

## Idempotent write contract

For each block ingestion transaction (or atomic batch equivalent):

1. write/update `indexed_blocks` for `block_height`,
2. write/update each entry in `indexed_entries`,
3. commit atomically if supported;
   otherwise use durable write-ahead markers for exactly-once recovery.

Conflict policy:

- same `block_height` + different `block_hash` => continuity fault, halt worker and alert operator,
- duplicate records with identical canonical payload => safe no-op/update timestamp.

## Versioning and migration strategy (backend-agnostic)

Track storage evolution with monotonic manifests under indexer runtime tree:

```text
explorer/backend/indexer/storage/
  manifests/
    0001_entities_baseline.yaml
    0002_indexes_and_projections.yaml
```

For each manifest revision include:

- entity/key changes,
- backfill/recompute instructions,
- compatibility notes for running workers,
- rollback posture.

Rules:

- never mutate an applied manifest revision,
- prefer additive changes,
- for breaking changes require replay/backfill plan + operator runbook updates.

## Backfill and retention posture

- `indexed_blocks` and `indexed_entries` are retained as canonical analytical history.
- `metric_windows` is derived and recomputable.
- retention/compaction is allowed only if the retained range still supports deterministic recomputation for advertised metrics.

## Implementation progress

Completed:

1. Concrete storage manifests landed at:
   - `explorer/backend/indexer/storage/manifests/0001_entities_baseline.yaml`
   - `explorer/backend/indexer/storage/manifests/0002_indexes_and_projections.yaml`
2. Snapshot-backed storage adapter landed at:
   - `explorer/backend/src/indexer/metrics-storage.service.ts`
   - wired into `explorer/backend/src/indexer/indexer-metrics.service.ts` for state restore/persist.

Remaining:

1. Bind runtime models/codecs for deterministic serialization.
2. Add replay/integration tests asserting idempotency and continuity-fault behavior.
