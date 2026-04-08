# API → Consensus Sync Implementation Checklist

Status: Draft implementation checkpoint checklist for making API submissions flow through consensus so Alpha/Beta/Gamma converge on the same committed ledger state.

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
- [ ] Define minimal interface:
  - [x] `enqueue(entry: LedgerEntry) -> EnqueueResult`
  - [x] `drain(max: usize) -> Vec<LedgerEntry>`
  - [x] Optional: `len()` for diagnostics.
- [x] Add deterministic dedupe policy (recommended by `entry_id`).
- [ ] Add unit tests:
  - [x] enqueue/drain order behavior.
  - [x] dedupe behavior.
  - [x] max-batch drain behavior.

## Checkpoint 2 — API write path migration

- [ ] Update `/api/v1/entries/submit` and `/api/v1/envelopes/submit` flow:
  - [x] Keep auth and builder-credit checks.
  - [x] Keep envelope and namespace validation before queueing.
  - [x] Enqueue instead of immediate `ledger.apply_entry` + local block finalization.
- [ ] Return explicit queued response contract (`202 Accepted`).
  - [x] Include queue/entry identifiers needed for tracing.
- [ ] Preserve compatibility mode:
  - [x] Introduce config flag (e.g. `api_local_finalize_mode`) defaulting to current safe behavior for migration window.
  - [ ] Document intended default flip date/release.
- [ ] Add API tests:
  - [x] valid entry accepted and queued.
  - [x] invalid entry rejected pre-queue.
  - [ ] auth/scope/rate-limit behavior unchanged.

## Checkpoint 3 — Consensus integration

- [x] Extend `ConsensusEngine` to receive shared txpool handle.
- [x] Implement `collect_entries()` to drain txpool using `max_entries_per_block`.
- [ ] Ensure proposer includes drained entries in proposal entry root.
- [ ] Keep commit/finality path unchanged (`finalize_block` + `ledger.apply_block`).
- [ ] Add/adjust consensus tests:
  - [ ] proposal with non-empty entries.
  - [ ] commit applies entries once.
  - [ ] repeated commit/replay does not double-apply.

## Checkpoint 4 — Node/runtime wiring

- [x] In node bootstrap, instantiate one shared txpool per node process.
- [x] Pass txpool to both API server and consensus engine.
- [ ] Verify observer mode remains read-only and does not enqueue writes.
- [ ] Add startup logging fields for mode/queue diagnostics.

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

- [ ] Queue overflow strategy defined and tested.
- [ ] Restart semantics documented (in-memory queue loss vs persistence).
- [ ] Duplicate submissions across nodes handled deterministically.
- [ ] Metrics added (queue length, enqueue/dequeue rates, rejected duplicates).
- [ ] Alerting hooks documented for stuck queue / zero-throughput conditions.

## Checkpoint 7 — Documentation + rollout

- [ ] Update localnet/runbook docs to describe consensus-backed ingestion path.
- [ ] Document compatibility flag and migration guidance.
- [ ] Add operator note: manifest/admission secures peers but does not replace ingestion/consensus wiring.
- [ ] Add release note entry for API submission semantics change.

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
