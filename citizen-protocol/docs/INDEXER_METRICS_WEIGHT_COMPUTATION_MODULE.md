# Indexer Metrics Weight Computation Module (Checkpoint 3)

Status: implementation-ready module contract and deterministic fixture plan for Checkpoint 3 of `INDEXER_METRICS_IMPLEMENTATION_CHECKLIST.md`.
Last updated: 2026-04-12.

## Purpose

Define a shared, deterministic weight-computation module that can be used by the indexer ingest worker, replay/backfill tooling, and verification scripts without duplicating serialization logic.

This document is intentionally implementation-oriented and aligned to:

- `INDEXER_METRICS_SPEC.md` for canonical metric semantics,
- `INDEXER_METRICS_INGESTION_ARCHITECTURE_NOTE.md` for ingest flow integration,
- `INDEXER_METRICS_DATA_MODEL_AND_SCHEMA.md` for persistence of `*_weight_bytes`.

## Module boundary

Recommended crate/module location (subject to workspace wiring decisions):

- `citizen-protocol/crates/api` as a shared codec utility if indexer runs adjacent to API services, or
- dedicated `citizen-protocol/crates/metrics` crate if broader reuse is needed.

Required public API:

- `compute_entry_weight(entry: &EntryLike) -> u64`
- `compute_block_weight(block: &BlockLike) -> u64`
- `canonical_json_bytes<T: Serialize>(value: &T) -> Vec<u8>` (internal/public-by-need)

Design rule:

- both weight functions must call the same canonical serializer path,
- no alternate fast-path encoders for blocks vs entries,
- no lossy normalization steps.

## Canonical serializer contract

The serializer must emit canonical JSON UTF-8 bytes with the following invariants:

1. object/map keys sorted lexicographically (bytewise string ordering),
2. no insignificant whitespace,
3. arrays preserved in committed order,
4. stable JSON number/boolean/null encoding,
5. UTF-8 output only.

### Rust implementation notes

Use a canonical JSON writer (or a wrapper around `serde_json`) that guarantees recursive key ordering. Avoid relying on insertion order from `HashMap`/`BTreeMap` conversions performed implicitly by caller code.

Implementation guidance:

- convert map-like structures into deterministically sorted key/value pairs before final emit,
- preserve exact committed values for encrypted payload blobs and metadata,
- reject/flag non-serializable structures rather than silently coercing.

## Function semantics

### `compute_entry_weight`

1. Receive entry in canonical runtime representation (or decoded adapter type preserving all committed fields).
2. Serialize via canonical serializer.
3. Return `byte_len as u64`.

Failure policy:

- return explicit error at call boundary (or structured result type) on decode/serialization failure,
- caller marks decode status as malformed and skips materialization per metrics spec.

### `compute_block_weight`

1. Receive full committed block object including header + entries.
2. Serialize via same canonical serializer.
3. Return `byte_len as u64`.

Important:

- block weight is not computed as sum(entry weights),
- block metadata/header bytes are part of canonical block weight.

## Deterministic fixtures and test vectors

Create repo fixtures under:

```text
citizen-protocol/docs/fixtures/indexer-metrics/weights/v1/
```

Recommended file layout:

```text
entry_case_*.json
block_case_*.json
manifest.yaml
```

`manifest.yaml` should bind each fixture to expected bytes/weights:

- `fixture_id`
- `kind` (`entry` | `block`)
- `source_file`
- `expected_weight_bytes`
- `notes`

### Required fixture classes

1. **Baseline deterministic case**
   - small entry + small block with fixed field ordering challenges.
2. **Cross-process reproducibility case**
   - values with nested maps/arrays and unicode payload text.
3. **Boundary: empty payload**
   - valid entry where payload object is empty.
4. **Boundary: large payload**
   - large encrypted-like blob/base64 string.
5. **Boundary: selective encrypted fields**
   - mixed plaintext metadata + encrypted field commitments.
6. **Empty block case**
   - header-only block with zero entries.

### Regression fixture source

Add at least one fixture class derived from sampled committed blocks from local simulation outputs so that future serialization changes are caught by CI.

## Test matrix

Minimum required tests:

1. **Determinism unit tests**
   - same value serialized multiple times in one process yields identical bytes.
2. **Cross-process reproducibility test**
   - fixture runner executed in separate process invocations yields same expected weights.
3. **Golden fixture tests**
   - all fixtures match `expected_weight_bytes` exactly.
4. **Malformed payload behavior tests**
   - decode/serialization failure is surfaced and counted, not silently normalized.

Suggested command targets once implemented:

- `cargo test -p <weight-module-crate>`
- `cargo test -p citizen-simulation indexer_metrics_weight_regression`

## Integration points

### In ingest loop (Checkpoint 4)

For each fetched block:

1. run continuity validation,
2. call `compute_block_weight`,
3. iterate entries calling `compute_entry_weight`,
4. persist results atomically with cursor update.

### In verification/backfill (Checkpoint 9)

Use the same module to recompute sampled historical weights; prohibit custom script-local serialization logic.

## Acceptance criteria for Checkpoint 3 completion

Checkpoint 3 is considered complete when all of the following are true:

1. shared module exists in workspace with public weight APIs,
2. canonical serializer contract is enforced by tests,
3. deterministic fixtures are committed,
4. regression test covers at least one real sampled block fixture,
5. checklist status is updated with implementation artifact path.

## Out of scope

- window aggregation logic,
- metrics API endpoint definitions,
- explorer UI wiring.
