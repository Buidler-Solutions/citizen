# Network Admission Localnet Staged Rollout Record

## Objective

Record the staged localnet rollout gate for network admission before production validator rollout.

## Rollout Stages

### Stage 0 — Admission preflight matrix (required)

Command:

```bash
cargo test -p citizen-network --test admission --manifest-path citizen-protocol/Cargo.toml
```

Outcome:
- PASS (15/15 tests)
- Verified allowlist enforcement, identity tuple mismatch rejection, observer/validator parity, replay protection, and key rotation behavior.

### Stage 1 — Localnet rollout policy confirmation

- Confirmed rollout sequencing uses canary-first progression defined in `docs/NETWORK_IDENTITY_CHANGE_RUNBOOK.md`:
  1. Canary validators
  2. Observer rollout
  3. Full validator batch rollout
- Confirmed rollback/abort checkpoints remain unchanged and mandatory for production rollout.

### Stage 2 — Production rollout gate

Production rollout remains blocked until all of the following are complete:
- full admission CI matrix publication,
- telemetry dashboard confirmation,
- node/network/governance sign-off.

## Approval Summary

- Localnet staged rollout gate: **Completed**
- Production validator rollout gate: **Pending final sign-offs**
