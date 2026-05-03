# Wallet Desktop Alpha Flag Matrix (Checkpoint 9 / R9-A)

## Scope

This matrix defines rollout toggles for the internal-maintainer alpha of the Vaultier + Tauri desktop track. It is intentionally fail-closed: no setting in this matrix permits production-ready claims until signed packaging and bridge-audit gates are complete.

## Toggle Matrix

| Toggle | Default | Allowed values | Owner approval | Notes |
|---|---|---|---|---|
| `VAULTIER_RUNTIME_PROFILE` | `wb-simulation` | `wb-simulation`, `tauri-runtime` | Wallet Maintainer + Desktop Maintainer | `tauri-runtime` remains opt-in for parity drills only; do not set as release default before cross-platform packaging evidence. |
| `VAULTIER_ENABLE_RUNTIME_BRIDGE` | `false` (alpha rehearsal builds) | `true`, `false` | Desktop Maintainer | Must stay `false` for generic alpha rehearsals unless a specific runtime parity scenario is scheduled. |
| `VAULTIER_REQUIRE_RUNTIME_EVIDENCE_FOR_EJECT` | `true` | `true`, `false` | Security Maintainer | Keeps safe-eject fail-closed when runtime-backed flush/eject evidence is missing. |
| `VAULTIER_REMOVABLE_MEDIA_GATING` | `strict` | `strict`, `warn` | Wallet Maintainer + Security Maintainer | `strict` required for alpha sign-off packets; `warn` is prohibited for promotion decisions. |
| `VAULTIER_ALLOW_UNVERIFIED_RESTORE` | `false` | `true`, `false` | Security Maintainer | Must remain `false`; any temporary override requires incident log entry and same-day rollback. |

## Approval Record

- Wallet Maintainer: **required** for runtime/profile and media-gating changes.
- Desktop Maintainer: **required** for bridge enablement and release wiring changes.
- Security Maintainer: **required** for eject-evidence, restore-verification, and any downgrade-risk toggle.

## Release Rule

If any toggle deviates from the default values above, the release notes MUST include explicit justification, approver names, and rollback timing.
