# Indexer Metrics Ingestion Architecture Note

Status: initial implementation note for Checkpoint 1 of `INDEXER_METRICS_IMPLEMENTATION_CHECKLIST.md`.

## Objectives

- Build a deterministic replay pipeline from canonical runtime APIs.
- Preserve chain continuity validation before materializing derived metrics.
- Guarantee idempotent restart behavior from persistent cursor state.

## Canonical input source (phase 1)

Indexer reads from runtime HTTP APIs:

- `GET /blocks` for batched reverse pagination discovery/catch-up.
- `GET /blocks/:height` for exact-height reconciliation and continuity checks.

Direct event-stream ingestion is explicitly deferred to a later phase.

## Replay state and cursor model

Persisted cursor (single-writer model):

- `last_indexed_height` (u64)
- `last_indexed_block_hash` (hex string)
- `updated_at` (UTC timestamp)

Startup sequence:

1. Load cursor state (default to genesis-1 sentinel when empty).
2. Query runtime latest height.
3. Replay forward from `last_indexed_height + 1` to latest height.
4. Enter steady-state polling loop.

## Continuity validation

For each candidate block at height `h`:

1. Fetch block `h`.
2. Fetch block `h-1` when needed for validation cache misses.
3. Assert `block[h].header.prev_hash == block[h-1].hash` (or equivalent canonical hash field).
4. On mismatch:
   - mark cursor as `degraded`,
   - halt forward materialization,
   - trigger gap/recovery workflow.

## Gap detection and recovery

Gap scenarios:

- height exists in cursor history but API returns `null`/missing,
- continuity hash mismatch,
- unrecoverable decode failure.

Recovery policy:

1. Retry with exponential backoff (bounded attempts).
2. Re-read a safety range (`h-32` to `h`) for local repair.
3. If unresolved, freeze ingest and page operator.

## Idempotency guarantees

- Each block/entry write is keyed with unique constraints (`block_height`, `entry_id`).
- Processing transaction is atomic per block:
  - store block metrics,
  - store entry metrics,
  - advance cursor.
- If crash occurs before commit, cursor does not advance.
- If crash occurs after commit, replay re-runs but upsert semantics preserve one canonical row per key.

## Reorg policy (current environment)

Current runtime and operational model are finality-oriented. Short reorg handling is not implemented in phase 1.

If future environments introduce reorg-like behavior, add:

- rollback-safe cursor checkpoints,
- compensating deletes/recomputes for reverted heights,
- fork-choice provenance fields.

## State machine (text diagram)

```text
[BOOT]
  -> load_cursor
  -> [CATCH_UP]

[CATCH_UP]
  -> fetch_next_height
  -> validate_continuity
  -> compute_weights
  -> persist_atomic
  -> advance_cursor
  -> (if height == latest) [STEADY_POLL]

[STEADY_POLL]
  -> poll_latest
  -> (if new height) [CATCH_UP]
  -> (if no new height) sleep_interval

[Any state]
  -> on_gap_or_mismatch [DEGRADED]

[DEGRADED]
  -> bounded_retries
  -> (recovered) [CATCH_UP]
  -> (not recovered) [OPERATOR_INTERVENTION]
```

## Operational logging requirements

Emit structured logs with at least:

- `indexed_height`,
- `runtime_latest_height`,
- `ingestion_lag`,
- `retry_count`,
- `continuity_check_status`,
- `cursor_state`.

## Out of scope for this note

- storage schema migration DDL,
- API response contracts for metrics consumers,
- explorer UI wiring.
