# Wallet Extension Backup Security Boundaries

## Scope

Defines the current security boundary expectations for encrypted backup flows in the browser extension surface.

## Runtime Isolation Boundaries

- **Page context is untrusted.** Dapp/page scripts must never receive raw wallet secret material.
- **Content script is a constrained bridge.** It may relay user-approved requests but must not persist decrypted secret payloads.
- **Background/service worker is the privileged boundary.** Backup orchestration logic, policy checks, and encrypted payload handling remain in extension-controlled runtime.
- **UI surfaces are presentation-only by default.** Popup/options screens should consume sanitized status objects and deterministic error IDs, not secret-bearing payloads.

## Backup Data Handling Rules

- Backup exports must remain encrypted at rest and in transit across extension internal messaging channels.
- Passphrases and secret-like values must be redacted from logs, telemetry, and user-visible diagnostics.
- Any bridge object crossing runtime boundaries should follow deterministic schema contracts and reject unknown secret-like fields.
- Recovery/restore conflicts should be resolved through explicit user confirmation and deterministic precedence rules; implicit overwrite behavior is disallowed.

## Browser Storage Constraints

- Extension-managed storage should keep only non-secret profile metadata where possible (e.g., labels, schema version, verification timestamps).
- Secret-bearing backup artifacts should be user-custody controlled (e.g., removable media/filesystem export), not retained as plaintext in extension storage.
- If browser storage is used for encrypted interim artifacts, those artifacts must remain encrypted and bounded by retention policy.

## Deterministic Error and UX Safety Contract

- Backup/restore failures should map to deterministic, machine-safe identifiers (for example `media_unavailable`, `decrypt_failed`, `checksum_mismatch`) and include human-readable next actions.
- UI copy must avoid overclaiming guarantees; decoy workflows and deniability limits must be explained explicitly.
- “What this cannot protect against” disclosures should be visible during setup and restore confirmation.

## Known Limits (Current State)

- Extension-side decoy/critical full flow UX and end-to-end integration tests remain open checklist items.
- Browser runtime differences (service-worker lifecycle, storage quotas, extension host policies) require ongoing compatibility validation before production-ready claims.
