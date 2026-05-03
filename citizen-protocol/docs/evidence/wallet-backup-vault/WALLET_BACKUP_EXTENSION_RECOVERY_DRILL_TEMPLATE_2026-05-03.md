# Wallet Backup Extension Recovery Drill Evidence Template (Checkpoint 6)

Date: 2026-05-03  
Owner: Wallet maintainers  
Scope: Browser extension backup vault recovery safety validation

## Goal

Provide reproducible evidence for the remaining Checkpoint 6 exit criterion requiring recovery drills across extension scenarios.

## Required Scenario Matrix

1. Create decoy+critical extension backup vault.
2. Export encrypted payload for both roles.
3. Simulate local credential loss/reset.
4. Restore with **replace existing IDs** mode.
5. Restore with **keep existing IDs** mode.
6. Run verify flow and capture deterministic success markers.
7. Corrupt payload and confirm deterministic failure taxonomy.

## Command/Test Evidence

Run from `wallet/browser`:

```bash
pnpm test background.backupVault.integration.test.ts
```

Attach:
- terminal log output,
- runtime/build metadata,
- commit SHA,
- any deterministic error-code assertions.

## Maintainer Sign-off

- Wallet maintainer: _pending_
- Wallet support maintainer: _pending_
- Crypto maintainer (review-only): _pending_

## Notes

As of 2026-05-03 this template is added to close documentation/readiness gaps for Checkpoint 6 extension evidence collection. It does **not** claim completion until a filled evidence record is committed.
