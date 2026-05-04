# Wallet Backup Vault Execution Guidelines (Anti-Stall)

## Goal

Provide a fast, deterministic execution lane for closing the remaining wallet backup vault blockers without work getting stuck across teams.

## Golden Rule

Never start downstream rollout evidence tasks until the current blocker lane is fully green and linked in the checklist.

## Required Execution Lanes (Strict Order)

1. **Lane A — TV-3 Packaging Evidence (All OS)**
   - Attach signed Linux artifact + immutable digest links.
   - Attach signed macOS artifact + immutable digest links.
   - Attach signed Windows artifact + immutable digest links.
   - Cross-link published artifact manifest into Checkpoint 9 R9-D.

2. **Lane B — Bridge Audit Evidence (All OS + Consolidated Sign-off)**
   - Attach Linux bridge audit evidence link.
   - Attach macOS bridge audit evidence link.
   - Attach Windows bridge audit evidence link.
   - Attach consolidated wallet+desktop+security maintainer sign-off URI.

3. **Lane C — R9-D Release Checklist Sign-off Packet**
   - Collect signed packaging/repro artifacts + immutable digests.
   - Attach final bridge memory/logging audit evidence.
   - Record wallet/desktop/security dated approvals.

4. **Lane D — R9-E Post-Rollout Validation**
   - Complete one full alpha drill cycle on Linux/macOS/Windows.
   - Publish local-only telemetry threshold summary.
   - Publish dated validation summary and cross-link checklist.

5. **Lane E — Checkpoint 9 Exit Criteria Closure**
   - Mark release checklist signed off.
   - Mark post-rollout validation report completed.
   - Mark beta promotion decision pack approved.

## Anti-Stall Rules

- **One owner per lane** with explicit backup owner.
- **48-hour SLA** per unresolved evidence item once lane is active.
- **No parallel bypass** to a later lane when an earlier lane has open checklist items.
- **Daily evidence heartbeat**: each active lane must publish one status artifact (link, command output, or blocker note).
- **Fail-closed gating**: if required evidence fields are `UNSET`, lane remains blocked.

## Command-Driven Daily Closure Loop

From repository root:

```bash
pnpm --dir wallet/desktop tv3:unblock-priority
pnpm --dir wallet/desktop tv3:unblock-priority:strict
pnpm --dir wallet/desktop tv3:gate-check
pnpm --dir wallet/desktop tv3:portable-smoke-gate
```

If output reports blockers:

1. Execute only the first unresolved lane.
2. Attach evidence links.
3. Update checklist checkboxes and references in the same change.
4. Re-run commands until first unresolved lane advances.

## Definition of Done (Execution)

Execution is complete only when:

- TV-3 signed artifacts and bridge audits are fully linked for all OS targets.
- R9-D and R9-E evidence is attached and approved.
- Checkpoint 9 exit criteria are checked.
- `tv3:unblock-priority` reports no unresolved blocker lanes.
