# API → Consensus Sync Implementation Checklist

Status: Draft implementation checkpoint checklist for making API submissions flow through consensus so Alpha/Beta/Gamma converge on the same committed ledger state.

Last updated: 2026-04-08 (localnet configs flipped to consensus-backed ingestion by default).

## Objective

- Replace node-local API finalization with consensus-driven block inclusion.
- Ensure entries submitted to one validator are committed and readable on all validators after finality.

## Scope Boundaries

- In scope: validator write path, tx ingress/queue, consensus collection, node wiring, integration tests, localnet validation.
- Out of scope: protocol economics, manifest policy redesign, major consensus algorithm changes.

## Checkpoint 0 — Baseline confirmation (pre-change)

- [ ] Confirm current API submit path applies entries and finalizes locally.
- [ ] Confirm consensus `collect_entries()` is placeholder/empty.
- [ ] Capture baseline localnet evidence where submit-to-alpha is not visible on beta/gamma.
  - [ ] Save curl output for Alpha/Beta/Gamma namespace reads.
  - [ ] Save validator logs and block heights.

## Checkpoint 1 — Transaction ingress queue (txpool)

- [x] Add shared ingress component (new module or crate, e.g. `crates/txpool`).
- [x] Define minimal interface:
  - [x] `enqueue(entry: LedgerEntry) -> EnqueueResult`
  - [x] `drain(max: usize) -> Vec<LedgerEntry>`
  - [x] Optional: `len()` for diagnostics.
- [x] Add deterministic dedupe policy (recommended by `entry_id`).
- [x] Add unit tests:
  - [x] enqueue/drain order behavior.
  - [x] dedupe behavior.
  - [x] max-batch drain behavior.

## Checkpoint 2 — API write path migration

- [x] Update `/api/v1/entries/submit` and `/api/v1/envelopes/submit` flow:
  - [x] Keep auth and builder-credit checks.
  - [x] Keep envelope and namespace validation before queueing.
  - [x] Enqueue instead of immediate `ledger.apply_entry` + local block finalization.
- [x] Return explicit queued response contract (`202 Accepted`).
  - [x] Include queue/entry identifiers needed for tracing.
- [x] Preserve compatibility mode:
  - [x] Introduce config flag (e.g. `api_local_finalize_mode`) defaulting to current safe behavior for migration window.
  - [x] Document intended default flip date/release.
- [x] Add API tests:
  - [x] valid entry accepted and queued.
  - [x] invalid entry rejected pre-queue.
  - [x] auth/scope/rate-limit behavior unchanged.

## Checkpoint 3 — Consensus integration

- [x] Extend `ConsensusEngine` to receive shared txpool handle.
- [x] Implement `collect_entries()` to drain txpool using `max_entries_per_block`.
- [x] Ensure proposer includes drained entries in proposal entry root.
- [x] Keep commit/finality path unchanged (`finalize_block` + `ledger.apply_block`).
- [x] Add/adjust consensus tests:
  - [x] proposal with non-empty entries.
  - [x] commit applies entries once.
  - [x] repeated commit/replay does not double-apply.

## Checkpoint 4 — Node/runtime wiring

- [x] In node bootstrap, instantiate one shared txpool per node process.
- [x] Pass txpool to both API server and consensus engine.
- [x] Verify observer mode remains read-only and does not enqueue writes.
- [x] Add startup logging fields for mode/queue diagnostics.

## Checkpoint 5 — Localnet convergence validation

- [ ] Run three-validator localnet.
- [ ] Submit entry to Alpha only.
- [ ] Wait 1–2 block intervals.
- [ ] Verify entry appears on Alpha/Beta/Gamma via read API.
- [ ] Verify block height progression is consistent across nodes.
- [ ] Capture evidence artifacts:
  - [ ] curl outputs,
  - [ ] node logs,
  - [ ] block/receipt references.

## Checkpoint 6 — Failure/operability checks

- [x] Queue overflow strategy defined and tested.
- [x] Restart semantics documented (in-memory queue loss vs persistence).
- [x] Duplicate submissions across nodes handled deterministically.
- [x] Metrics added (queue length, enqueue/dequeue rates, rejected duplicates).
- [x] Alerting hooks documented for stuck queue / zero-throughput conditions.

### Checkpoint 6 implementation notes

- `citizen-txpool` now enforces bounded capacity via `TxPool::with_capacity(capacity)` and returns `EnqueueResult::Full { .. }` when the queue is saturated.
- API submission handlers map queue saturation to `429 Too Many Requests` with `status: "queue_full"` and queue capacity diagnostics.
- Coverage added in txpool + API tests for saturation behavior.
- `citizen-txpool` now maintains counters for `enqueued_total`, `drained_total`, `enqueue_rejected_duplicate_total`, and `enqueue_rejected_full_total`, exposed via `metrics_snapshot()`.
- API queued/duplicate/full responses now include queue telemetry fields (`queue_len`, `queue_capacity`, and relevant counters) for operator diagnostics.
- `citizen-ledger::Ledger::apply_entry` now rejects repeated `entry_id` submissions in the same namespace before persistence, so duplicate submissions racing across validators converge on deterministic duplicate rejection rather than double-write behavior.
- Coverage added in ledger tests to assert duplicate `entry_id` submissions are rejected and do not create additional stored entries.
- Localnet runbook now documents queue-health alerting hooks for stuck queue / zero-throughput conditions tied to txpool telemetry counters.

## Checkpoint 5 implementation notes (in progress)

- Localnet validator configs now set `api_local_finalize_mode = false` for Alpha/Beta/Gamma so default `scripts/run_localnet.sh` launches exercise consensus-backed ingestion semantics without extra manual edits.
- Added scripted evidence harness at `scripts/capture_api_consensus_sync_evidence.sh` to launch the three-validator localnet, submit to Alpha, assert Beta/Gamma visibility, verify height parity, and write timestamped artifacts under `docs/artifacts/`.
- Evidence harnesses now support operational overrides: `NODE_BIN` (reuse prebuilt binary), `CARGO_BUILD_TIMEOUT_SECONDS`, `LOCALNET_STARTUP_TIMEOUT_SECONDS`, and `POST_SUBMIT_WAIT_SECONDS` to make long-running/locked build environments fail fast and remain tunable.
- Remaining Checkpoint 5 evidence capture (curl artifacts/log snapshots/block-height parity) is still pending a full localnet validation run in the implementation PR context using the new harness.

## Checkpoint 0 implementation notes (in progress)

- Added scripted baseline harness at `scripts/capture_api_consensus_sync_baseline_evidence.sh` to run Alpha/Beta/Gamma with temporary `api_local_finalize_mode = true` overlays, submit to Alpha, and capture divergence artifacts under `docs/artifacts/`.
- The baseline harness asserts the expected pre-change behavior (`alpha_contains=true`, `beta_contains=false`, `gamma_contains=false`) and emits API snapshots/log tails needed for the historical comparison checkpoint.
- Baseline harness supports the same runtime overrides as the convergence harness (`NODE_BIN`, build/startup/wait timeout env vars) so local and CI runs can tune execution deterministically.
- Baseline evidence artifacts still need to be captured in this PR context (same as Checkpoint 5 convergence evidence capture), then linked directly in this checklist.

## Checkpoint 7 — Documentation + rollout

- [x] Update localnet/runbook docs to describe consensus-backed ingestion path.
- [x] Document compatibility flag and migration guidance.
- [x] Add operator note: manifest/admission secures peers but does not replace ingestion/consensus wiring.
- [x] Add release note entry for API submission semantics change.

### Checkpoint 7 implementation notes

- Added localnet runbook guidance for `api_local_finalize_mode` migration and the consensus-backed ingestion path (`202` queued response, `429 queue_full` on saturation).
- Added explicit operator note that manifest/admission peer security is necessary but not sufficient for API write convergence; ingestion/consensus wiring must still be enabled.
- Added restart semantics guidance clarifying current in-memory txpool loss on restart, durable committed state behavior, and idempotent client retry expectations.
- Added operator-facing release-note entry for v0.4.0 migration planning: API writes are queue-first in consensus-backed mode and converge through consensus finality instead of node-local immediate finalization.

## Acceptance Criteria (definition of done)

- [ ] Submit-once to Alpha results in committed visibility on Beta/Gamma after finality.
- [ ] No node-local-only finality path in normal validator mode.
- [ ] Consensus proposals include real queued entries (non-empty under load).
- [ ] Existing validation/auth/policy behavior remains enforced.
- [ ] Tests and localnet evidence are attached in the implementing PR.

## Recommended Implementation Order

1. Txpool primitive + tests.
2. API queue path behind compatibility flag.
3. Consensus `collect_entries()` integration.
4. Node wiring + integration tests.
5. Flip localnet configs to consensus-backed mode and validate convergence.
6. Update runbooks and remove legacy path (or schedule removal).

## Migration note (compatibility flag default)

- `api_local_finalize_mode` remains `true` by default during the migration window.
- Intended default flip target: **release v0.4.0 (target date: 2026-06-30)**, gated by:
  - completion of Checkpoint 5 localnet convergence evidence,
  - completion of Checkpoint 6 operability checks,
  - runbook rollout updates in Checkpoint 7.
