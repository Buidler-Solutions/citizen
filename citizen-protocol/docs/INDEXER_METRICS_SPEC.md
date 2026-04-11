# Indexer Metrics Canonical Specification (TPS + Block Weight + Entry Weight)

Status: approved baseline for Checkpoint 0 of `INDEXER_METRICS_IMPLEMENTATION_CHECKLIST.md`.

## Scope

This specification defines canonical, reproducible analytics metrics computed by an indexer from committed ledger data. The runtime node remains the canonical source of chain state; indexer outputs are derived views.

## Canonical definitions

### 1) Transactions/entries per second (TPS)

- **Definition:**
  - `TPS(window) = entries_committed(window) / window_duration_seconds`
- **entries_committed(window):**
  - Count of committed entries where entry `timestamp` is in the half-open interval `[window_start, window_end)`.
- **window_duration_seconds:**
  - Exact integer duration in seconds (`10`, `60`, `300`, `3600` for the initial windows).

### 2) Entry weight

- **Definition:**
  - Canonical serialized byte length of one committed entry.
- **Formula:**
  - `entry_weight_bytes = len(canonical_entry_bytes(entry))`

### 3) Block weight

- **Definition:**
  - Canonical serialized byte length of one committed block.
- **Formula:**
  - `block_weight_bytes = len(canonical_block_bytes(block))`

## Canonical serialization contract

To guarantee deterministic recomputation across operators and services:

- Serialization family: **canonical JSON UTF-8 bytes**.
- Objects/maps:
  - keys sorted lexicographically,
  - no insignificant whitespace,
  - stable escaping per JSON rules.
- Arrays:
  - preserve original order from committed payload.
- Numbers/booleans/null:
  - encoded in standard JSON representation.

The weight module implementation must expose:

- `compute_entry_weight(entry) -> u64`
- `compute_block_weight(block) -> u64`

and use the same canonical JSON implementation for both.

## Edge cases and handling

### Empty blocks

- If a block has zero entries, `entry_count = 0` and `block_weight_bytes` is still computed from the full canonical block object.

### Mixed entry types

- Entries with different `namespace`/`action` are all included in the same block weight calculation.
- Each entry also has its own independently computed `entry_weight_bytes`.

### Privacy/encrypted payload entries

- Weight is computed on the committed payload exactly as stored on-chain.
- Encrypted blobs, field commitments, ACL metadata, and receipt references all contribute to byte length if present.
- No decryption is required for metric computation.

### Malformed historical payload fallback

- If an entry/block cannot be decoded into canonical typed structs during backfill:
  - record `decode_status = malformed` in indexer internal logs/diagnostics,
  - do not silently coerce data,
  - skip metric materialization for that object until operator remediation or parser update.
- Aggregations must exclude malformed objects and increment a dedicated failure counter.

## Precision and rounding rules

- `*_weight_bytes` are integer byte counts (`u64`).
- `entries_committed` is an integer count (`u64`).
- `tps` is represented as decimal with fixed precision:
  - store as decimal with **3 fractional digits**,
  - round half away from zero,
  - expose as JSON number in API responses.

## Stable ordering for deterministic recomputation

When recomputing windows or backfilling:

1. Process blocks in ascending `height`.
2. Within a block, process entries in committed order.
3. For window materialization writes, order by `(window_start, window_name)`.
4. For ties on timestamp during API reads, order by `(timestamp, height, entry_id)`.

## Worked examples

### Example A: TPS over 60 seconds

- Window `[12:00:00Z, 12:01:00Z)` contains `120` entries.
- `TPS = 120 / 60 = 2.000`.

### Example B: Empty block

- Block height `101` has `0` entries.
- Canonical block bytes length is `412` bytes.
- `block_weight_bytes = 412`.

### Example C: Encrypted entry

- Entry includes encrypted payload fields and consent metadata.
- Canonical entry bytes length is `1398` bytes.
- `entry_weight_bytes = 1398`.

## Compatibility and versioning

- This spec is `metrics-spec/v1`.
- Any change to canonical serialization rules, window boundaries, or precision requires:
  1. new spec version,
  2. migration/backfill note,
  3. explorer/indexer API compatibility update.
