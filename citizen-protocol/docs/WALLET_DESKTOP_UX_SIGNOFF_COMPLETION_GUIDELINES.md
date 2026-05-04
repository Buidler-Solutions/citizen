# Wallet Desktop UX Sign-off Completion Guidelines (TV-3 "Working + Sleek")

## Purpose

Close the portable-track UX sign-off gate with deterministic, reviewer-attested evidence so the checklist can move from `[~]` to `[x]` without ambiguity.

This guide turns the template artifact (`TV3_UX_SLEEK_SIGNOFF_TEMPLATE_*.md`) into a completed sign-off record tied to reproducible smoke evidence and immutable links.

## Preconditions

Before running UX review, ensure all of the following are true:

1. Latest cross-platform portable smoke evidence is present for Linux/macOS/Windows.
2. `pnpm --dir wallet/desktop tv3:portable-smoke-gate` passes fail-closed.
3. Desktop build under test matches the signed artifact identifiers referenced in smoke evidence.
4. Review hardware/OS matrix is recorded (host class, OS version, display scaling, input device).

## Required Evidence Contract

The completed UX artifact must keep schema `citizen.wallet.desktop.tv3.ux-signoff.v1` and replace every `UNSET` field with concrete values.

Minimum required fields:

- Immutable walkthrough URI (video).
- Immutable screenshot set URI.
- Guided backup duration in seconds.
- Pass/fail evaluation against `< 180` seconds.
- Ambiguous error-copy count.
- Visual hierarchy assessment (critical action order + decoy/critical clarity).
- Reviewer identity, role, date, decision, and blocking issues (or explicit `none`).

## Test Procedure (Deterministic)

Run one clean UX pass for each target OS profile:

1. Launch desktop app in production-like mode with signed build.
2. Execute guided flow: `create -> add-slot -> export -> verify -> restore -> safe-eject guidance`.
3. Start timer at first user action; stop when safe-eject guidance is visible and actionable.
4. Capture every surfaced warning/error/toast and map each to deterministic wallet/bridge error taxonomy.
5. Take screenshots at each critical stage:
   - vault creation
   - slot role selection
   - export completion
   - verify result
   - restore confirmation
   - eject guidance
6. Record a full-session walkthrough video.
7. Repeat once with an injected expected error (e.g., wrong passphrase) to confirm clarity and non-ambiguous remediation copy.

## Acceptance Rubric

A run is sign-off eligible only if all conditions pass:

- **Time target:** Guided backup is `< 180` seconds for first-time operator with runbook prompts.
- **Error clarity:** `0` ambiguous errors; every error contains clear cause + deterministic next step.
- **Visual hierarchy:** Primary critical actions are visually dominant and ordered; decoy vs critical actions are clearly separated.
- **Reliability:** No hangs/crashes, and verify/restore outcomes are deterministic and reproducible.

If any condition fails, mark decision `fail`, list blocking issues, and attach remediation owner/date.

## Artifact Finalization Steps

1. Generate the latest template:
   - `pnpm --dir wallet/desktop tv3:ux-signoff-template`
2. Copy to a dated evidence file (do not overwrite historical records), for example:
   - `citizen-protocol/docs/evidence/wallet-backup-vault/TV3_UX_SLEEK_SIGNOFF_YYYY-MM-DD.md`
3. Replace all `UNSET` fields.
4. Add immutable URIs for video/screenshots and smoke evidence linkage.
5. Obtain reviewer sign-off (wallet maintainer or delegated UX/security approver).
6. Update checklist exit criterion from `[~]` to `[x]` only after reviewer decision is `pass`.

## Change-Control + Regression Guard

When UX sign-off reaches `pass`:

- Link the finalized UX sign-off evidence in:
  - `WALLET_ENCRYPTED_BACKUP_VAULT_IMPLEMENTATION_CHECKLIST.md`
  - `TV3_R9D_R9E_SIGNOFF_PACKET_*.md` (or successor packet)
- Re-run portable-track gap report in strict mode:
  - `pnpm --dir wallet/desktop tv3:portable-track-gap-report:strict`
- If a later UI/bridge behavior change affects guided flow, regenerate and re-sign UX evidence.

## Definition of Done

The UX gate is done only when:

- Template fields are fully populated (no `UNSET`).
- Reviewer decision is `pass`.
- Evidence links are immutable and accessible to maintainers.
- Checklist exit criterion is updated to `[x]` with evidence citation.
