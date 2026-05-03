# Wallet Desktop Beta Promotion Memo Template

## Purpose

Use this template to propose **alpha -> beta** promotion for the Vaultier/Tauri desktop backup runtime.

> Gate reminder: do not approve beta promotion until Checkpoint 9 R9-D and R9-E artifacts are complete and linked.

## Release Window

- Proposed decision date:
- Proposed beta enable date:
- Release train / tag:
- Memo owner:

## Required Attachments (must all be present)

1. Signed desktop artifact digests (Linux/macOS/Windows).
2. Reproducibility evidence and packaging metadata.
3. Final runtime bridge memory/logging audit record.
4. Completed alpha drill packet set (all target OS runs).
5. Telemetry threshold summary (local-only counters from alpha cycle).

## Evidence Links

- Artifact digest bundle:
- Packaging/reproducibility record:
- Bridge audit record:
- Alpha drill packets:
- Telemetry summary:

## Threshold Check Summary

Reference policy: `WALLET_DESKTOP_BETA_PROMOTION_THRESHOLDS.md`.

- Per-OS alpha drill pass minimum met? (yes/no)
- Removable-media parity pass rate met? (yes/no)
- Unresolved redaction regressions present? (yes/no)
- Any blocker-class incident open? (yes/no)

## Owner Sign-Off

- Wallet owner:
- Desktop/runtime owner:
- Security owner:

## Decision

- Outcome: `go` / `no-go`
- Date:
- If `no-go`, link incident/escalation ticket(s):
- If `go`, specify beta flag enable scope and rollback trigger condition references.
