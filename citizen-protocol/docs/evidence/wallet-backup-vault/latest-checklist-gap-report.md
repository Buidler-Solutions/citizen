# Wallet backup checklist gap report

- Generated: 2026-05-03T03:06:28.986Z
- Priority gate status: **complete**
- Checkpoint 8.5 counts: pending=0, partial=0, complete=20

## Priority gate open items
- None.

## Full checklist section summary
- **USB-Centric Operating Requirements**: pending=2, partial=2, complete=3
- **Checkpoint 0 — Discovery, Threat Model, and Requirements**: pending=3, partial=0, complete=5
- **Checkpoint 1 — Monorepo Architecture and Package Layout**: pending=4, partial=0, complete=4
- **Checkpoint 2 — Cryptography and Vault Format**: pending=11, partial=0, complete=1
- **Checkpoint 3 — Multi-Vault / Decoy Capability**: pending=10, partial=0, complete=0
- **Checkpoint 4 — Wallet CLI Integration**: pending=1, partial=0, complete=11
- **Checkpoint 5 — Browser Extension Integration**: pending=5, partial=0, complete=2
- **Checkpoint 6 — Recovery Safety and Operator Runbooks**: pending=0, partial=2, complete=5
- **Checkpoint 7 — Testing Matrix and Quality Gates**: pending=2, partial=0, complete=5
- **Checkpoint 8 — Documentation and Developer Experience**: pending=5, partial=0, complete=2
- **Checkpoint 8.5 — Priority Gate (Do First): CLI Production-Grade Readiness (Blocker Before Vaultier Continuation)**: pending=1, partial=0, complete=22
- **Portable Application Track (Working + Sleek)**: pending=8, partial=9, complete=18
- **Checkpoint 9 — Rollout Plan**: pending=7, partial=0, complete=0
- **Minimum Viable Deliverable (MVD)**: pending=0, partial=0, complete=5
- **Open Questions (Track Before GA)**: pending=5, partial=0, complete=0
- **Implementation Continuation Plan (2026-05-01)**: pending=31, partial=10, complete=42

## Potential stale unchecked markers
- None detected.

## Full checklist open items

### USB-Centric Operating Requirements
- [~] Provide safe eject + write flush guidance in CLI and extension flows (CLI + Vaultier desktop now expose explicit flush/safe-eject guidance and commands; browser extension recovery surface guidance remains pending).
- [~] Detect common removable-media failure modes (Vaultier now surfaces deterministic `media_unavailable` disconnect detection + refresh checks, existing filesystem compatibility warnings, and flush-strategy completeness enforcement before marking safe-eject complete; wallet CLI persists vault files through atomic temp-write + `sync_all` + rename durability steps, and the Tauri desktop adapter now performs runtime `sync_all` flush attempts on vault files + parent directories and now attempts OS-native safe-eject commands on Linux (`udisksctl`/`umount`), macOS (`diskutil unmount`), and Windows (PowerShell eject verb) with deterministic fallback telemetry when manual eject is still required).
- [ ] End-to-end USB create/export/verify/restore drills pass on representative OS environments.
- [ ] Runbook includes USB hygiene guidance (offline custody, duplicate media, periodic integrity recheck).

### Checkpoint 0 — Discovery, Threat Model, and Requirements
- [ ] Enumerate credential artifacts that need backup from CLI and extension (seed material, keypairs, metadata, consent receipts where relevant).
- [ ] Define security and usability success criteria with measurable thresholds.
- [ ] Requirements and threat model reviewed by wallet + crypto maintainers.

### Checkpoint 1 — Monorepo Architecture and Package Layout
- [ ] `wallet/backup-vault` remains a future extraction option if extension/runtime sharing pressure grows.
- [ ] Define interop contract for CLI and extension clients (common schema + versioning).
- [ ] Architecture decision record (ADR) merged.
- [ ] Public interfaces versioned (`v1alpha1`/`v1`) with forward migration notes.

### Checkpoint 2 — Cryptography and Vault Format
- [ ] Define AEAD scheme (e.g., XChaCha20-Poly1305 or AES-256-GCM) and nonce/IV policy.
- [ ] Implement per-vault master key wrapping and per-object envelope encryption.
- [ ] Implement memory-hard unlock path and secure zeroization where feasible.
- [ ] Define vault file format:
- [ ] global magic/version
- [ ] slot table supporting `decoy`, `critical`, and future roles
- [ ] authenticated metadata
- [ ] rollback/anti-tamper counters
- [ ] Define corruption detection and deterministic error codes.
- [ ] Crypto design reviewed against current repo wallet/off-chain encryption patterns.
- [ ] Test vectors committed for key derivation, encryption, decryption, and tamper failure.

### Checkpoint 3 — Multi-Vault / Decoy Capability
- [ ] Support creation of 2+ independent encrypted vault slots in one container or linked containers.
- [ ] Implement explicit role metadata (`decoy`, `critical`, optional `archive`).
- [ ] Ensure decoy and critical slots are cryptographically unlinkable from ciphertext patterns as far as practical.
- [ ] Implement access policy:
- [ ] decoy passphrase unlocks only decoy slot
- [ ] critical passphrase unlocks critical slot(s)
- [ ] Add optional duress-safe UX guidance (without false guarantees).
- [ ] Implement slot-level wipe, rotation, and passphrase update.
- [ ] Demonstrated creation/unlock/rotation for decoy + critical flows in integration tests.
- [ ] Security review note explicitly states deniability boundaries and residual forensic risk.

### Checkpoint 4 — Wallet CLI Integration
- [ ] Add commands for backup vault lifecycle:

### Checkpoint 5 — Browser Extension Integration
- [ ] Add extension UI flow for creating decoy + critical backup vaults.
- [ ] Add secure export bridge for encrypted payload creation (never raw secret exfiltration to page context).
- [ ] Add restore flow with integrity checks and clear conflict resolution strategy.
- [ ] Add passphrase-strength guidance and recovery warnings.
- [ ] Extension integration tests pass for create/export/restore/verify.

### Checkpoint 6 — Recovery Safety and Operator Runbooks
- [~] Recovery drills executed for both CLI and extension scenarios. (CLI cross-machine USB drill is evidenced in `citizen-protocol/docs/evidence/wallet-backup-vault/WALLET_BACKUP_USB_CROSS_MACHINE_DRILL_2026-05-02.md`; equivalent extension drill evidence remains pending.)
- [~] Runbook approved by maintainers responsible for wallet support. (Wallet/crypto maintainer review and sign-off are recorded for the CLI path in `citizen-protocol/docs/evidence/wallet-backup-vault/WALLET_BACKUP_8_5_SIGNOFF_2026-05-02.md`; extension-specific support approval remains open.)

### Checkpoint 7 — Testing Matrix and Quality Gates
- [ ] Performance tests: unlock latency targets across workstation/laptop profiles.
- [ ] No critical/high findings open from pre-merge security review.

### Checkpoint 8 — Documentation and Developer Experience
- [ ] Update wallet generation/security docs with backup vault workflows.
- [ ] Provide “quick start” examples for CLI and extension recovery.
- [ ] Publish versioned vault format spec + migration strategy.
- [ ] Docs reviewed for consistency with architecture baseline and wallet security docs.
- [ ] All user-facing commands and JSON schema examples validated against implementation.

### Checkpoint 8.5 — Priority Gate (Do First): CLI Production-Grade Readiness (Blocker Before Vaultier Continuation)
- [ ] Complete cryptography closure items:

### Portable Application Track (Working + Sleek)
- [~] Current runtime bridge still uses cautious CLI shell execution (`citizen-wallet wallet backup ... --json`) as a temporary implementation bridge; in-process wallet-core bindings remain open.
- [ ] Production desktop readiness remains blocked on cross-platform packaging/signing, OS-native removable-media adapters, and final bridge memory/logging audit sign-off.
- [~] Any new Tauri desktop flow should land with WB-mode simulation tests first, then add real runtime adapter parity tests in a follow-up hardening PR. (Current Tauri bridge extensions continue to be paired with WB-mode/runtime contract tests; broader real-runtime parity expansion remains pending as hardening follow-up.)
- [~] Keep Tauri bridge responses field-compatible with the CLI v1 contract while replacing shell fallback incrementally. (Current bridge normalizes wrapped Tauri responses into the CLI v1-style `HeadlessResponse` envelope and parity tests pin command/result key/value snapshots for `backup_init`/`backup_add_slot`/`backup_export_credentials`/`backup_verify`/`backup_restore`/`backup_diagnostics`; remaining work is replacing shell-backed command execution with in-process wallet-core bindings.)
- [~] Add per-command parity snapshots to detect contract drift between WB-mode simulation and runtime adapter outputs. (Added version-pinned response shape fixture `vaultier/fixtures/command-result-shape.v1.json`; `vaultier/runtime-parity-check.mjs` now validates command coverage plus pinned top-level/result-value fixture expectations, and `vaultier/src/lib/runtimeBridge.test.ts` asserts per-command runtime top-level key parity, pinned top-level values, pinned result payload values for `init`/`add-slot`/`export-credentials`/`verify`/`restore`/`diagnostics`, and wrapped runtime error-code parity (`error_id` -> CLI `error.code`, e.g. `decrypt_failed`); full runtime payload parity against a production in-process bridge remains pending runtime hardening.)
- [~] Extend redaction checks so secret-like fields are rejected identically in WB-mode and runtime modes. (Runtime parity gate now asserts both `runtimeBridge` and WB-mode simulator keep deterministic redaction rejection markers, and runtime bridge tests now enforce command-by-command redaction-failure parity for `init`/`add-slot`/`export-credentials`/`verify`/`restore`/`diagnostics`; full runtime adapter evidence against the in-process bridge remains pending final hardening.)
- [~] Complete OS-native removable-media adapter coverage (Linux/macOS/Windows) with deterministic error parity. (Tauri bridge now attempts OS-native safe-eject commands on Linux (`udisksctl`/`umount`), macOS (`diskutil unmount`), and Windows (PowerShell eject verb) and preserves deterministic fallback error mapping; full signed cross-platform smoke evidence is still pending.)
- [ ] Produce signed/reproducible desktop artifacts and publish compatibility notes per release.
- [ ] Close final memory/logging bridge audit and attach evidence links in this checklist.
- [~] Choose runtime shell (Tauri remains the production target for Rust-native crypto reuse; Vaultier now hard-gates create/verify/restore behind an explicit mock-runtime rehearsal override whenever Tauri bridge evidence is unavailable, so desktop packaging sign-off still pending before marking complete).
- [ ] Package signed builds for macOS/Windows/Linux with reproducible build metadata.
- [~] Implement removable-drive discovery abstraction with platform-specific adapters and deterministic error mapping (Vaultier now routes discovery through explicit per-platform adapter boundaries, deterministic media disconnect detection (`media_unavailable`), and a Tauri runtime bridge contract that validates compatibility/free-space/writability constraints before surfacing candidate drives; desktop runtime now includes Linux `lsblk` discovery plus macOS (`diskutil`) and Windows (PowerShell/CIM DriveType=2) removable-drive discovery adapters, with signed cross-platform smoke evidence still pending).
- [~] Add crash-safe write strategy (temp file + fsync + atomic rename) for vault container updates (Vaultier now exposes explicit flush workflow in UX, validates required crash-safe steps before allowing safe-eject completion, includes Tauri bridge contracts for both flush strategy reporting and safe-eject execution (`flush_vault_writes`, `safe_eject_media`), and now hard-blocks safe-eject in Tauri mode when runtime-backed evidence is missing; full OS-native adapter enforcement remains pending).
- [ ] Add secure memory handling audit for desktop bridge boundaries (Rust core <-> UI layer).
- [ ] Portable app passes cross-platform smoke suite (create/add-slot/export/verify/restore/eject guidance).
- [ ] UX review sign-off confirms “working and sleek” bar: <3 minute guided backup, no ambiguous error copy, consistent visual hierarchy.
- [ ] Security review confirms no plaintext secret exposure across UI bridge, logs, or crash artifacts.

### Checkpoint 9 — Rollout Plan
- [ ] Phase 1: feature-flagged alpha for internal maintainers.
- [ ] Phase 2: opt-in beta for selected builders.
- [ ] Phase 3: default-on for new wallet onboarding with migration prompts for existing users.
- [ ] Define telemetry/metrics (local-only or privacy-preserving) for backup success and restore confidence.
- [ ] Define rollback and incident-response procedure.
- [ ] Release checklist signed off.
- [ ] Post-rollout validation report completed.

### Open Questions (Track Before GA)
- [ ] Single container with hidden slot semantics vs separate encrypted containers with coordinated UX.
- [ ] Hardware-backed key assistance (TPM/Secure Enclave/WebAuthn wrapping) as optional layer.
- [ ] Remote backup adapter requirements and trust boundaries.
- [ ] Enterprise policy hooks (mandatory periodic verify, escrow prohibitions, audit evidence).
- [ ] Long-term cryptographic agility strategy.

### Implementation Continuation Plan (2026-05-01)
- [ ] Finalize AEAD selection and document nonce policy in code comments + vault format notes (target: `XChaCha20-Poly1305`, unless wallet maintainers decide otherwise during review).
- [ ] Add explicit authenticated header fields for:
- [ ] schema version
- [ ] slot role
- [ ] KDF parameter set identifier
- [ ] payload checksum algorithm identifier
- [ ] Add deterministic vault corruption error mapping (`unsupported_schema`, `invalid_header`, `auth_failed`, `checksum_mismatch`, `slot_missing`) and ensure `--json` output uses stable identifiers.
- [ ] Add anti-rollback monotonic counter field in slot metadata with deterministic validation behavior.
- [ ] CLI round-trip fixtures pass across two independently generated vaults using the finalized format contract.
- [ ] Add CLI warnings and guidance for removable-media risks (partial write, unplug during flush, filesystem limits) in `init`, `export-credentials`, and `restore` command output/help text.
- [ ] Add explicit duplicate-media procedure (primary + sealed backup + verification cadence).
- [ ] Document minimum operator profile recommendations:
- [ ] removable media class/durability expectations
- [ ] expected free space margin
- [ ] integrity recheck interval guidance
- [ ] USB hygiene section is present in wallet runbook docs and cross-linked from this checklist.
- [ ] CI gate includes unit + integration + adversarial + fuzz/property coverage for backup-vault code paths.
- [ ] No unresolved critical severity findings remain in wallet backup security review notes.
- [ ] PR-D1 through PR-D4 merged with passing wallet crate tests.
- [ ] Remaining open items in this checklist are reduced to extension integration, optional hardware-assisted key wrapping, and rollout governance sign-off.
- [~] Expose minimal command bridge for `backup init`, `backup add-slot`, `backup export-credentials`, `backup verify`, `backup restore` using typed request/response DTOs. (`vaultier/src/lib/runtimeBridge.ts` defines typed Tauri bridge contracts for all five commands and `wallet/desktop/src-tauri/src/main.rs` now wires `run_backup_command` to invoke the wallet CLI command path with deterministic contract envelopes; remaining work is replacing shell execution with in-process wallet-core bindings and secure argument plumbing.)
- [~] Desktop shell now includes a runnable React+Vite app surface under `wallet/desktop` that invokes `run_backup_command` through the Tauri bridge with deterministic contract/error rendering for `backup_init`/`backup_add_slot`/`backup_export_credentials`/`backup_verify`/`backup_restore`; wallet-core in-process wiring remains pending, but the desktop runtime now accepts typed `payload.args` input and forwards command arguments through the Tauri bridge for runnable backup flows while avoiding payload echo in response logs. The Tauri bridge is feature-gated behind `desktop-runtime` so baseline `cargo check` can run without Linux WebKitGTK/JavascriptCore system packages, while runtime builds keep explicit native dependency requirements.
- [~] Enforce “no secret in UI logs” guardrails in bridge layer with redaction helpers and deny-list tests. (Vaultier Tauri bridge now sanitizes command payloads before surfaced error details and ships deterministic deny-list coverage in `vaultier/src/lib/runtimeBridge.test.ts`; full bridge-wide log sink audit remains pending.)
- [~] Implement cross-platform removable-drive discovery abstraction with deterministic adapter error mapping. (Tauri desktop bridge now exposes `discover_removable_drives` with deterministic compatibility/writable/free-space checks and explicit adapter warnings, but fully native removable-media adapter parity + signed smoke evidence is still open.)
- [~] Add crash-safe write path (`.tmp` write -> fsync -> atomic rename -> parent fsync when supported). (Wallet CLI path is now crash-safe via temp-write + flush + atomic rename durability steps and the Tauri bridge reports flush strategy/steps for desktop guidance; remaining closure is full native enforcement parity in packaged desktop releases.)
- [~] Add desktop headless mode that mirrors `wallet backup ... --json` contract for CI/recovery labs. (Vaultier headless command surface now includes `backup_diagnostics` and contract tests for diagnostics payload shape; remaining work is wiring real desktop runtime adapters.)
- [ ] Desktop smoke suite passes on Linux/macOS/Windows runners for create/add-slot/export/verify/restore happy paths.
- [ ] UX acceptance validates “working + sleek” baseline: first-time backup flow under 3 minutes with no ambiguous error language.
- [ ] Security review confirms no plaintext material crosses UI bridge, logs, crash dumps, or telemetry payloads.
- [ ] **Implement in-process wallet-core bridge** to replace shell invocation in `wallet/desktop/src-tauri/src/main.rs` while preserving the `citizen.wallet.backup.cli.v1` response contract.
- [ ] **Finish cross-platform packaging/signing lane** (macOS/Windows/Linux) with reproducible build metadata and release-note compatibility callouts.
- [ ] **Publish signed cross-platform removable-media smoke evidence** covering `discover_removable_drives`, `flush_vault_writes`, and `safe_eject_media` parity checks.
- [ ] **Close bridge memory/logging audit** with explicit evidence that secrets are not retained in UI logs, runtime logs, crash artifacts, or diagnostics export payloads.
- [ ] Add a desktop-facing Rust bridge module (or crate) that wraps backup operations with typed DTOs matching CLI JSON fields.
- [ ] Implement preflight checks: writable mount, minimum free space threshold, filename/path compatibility checks, and explicit “removable media likely/unknown” classification.
- [~] Map preflight failures into deterministic UI-safe error identifiers (`mount_unwritable`, `insufficient_space`, `path_invalid`, `media_unavailable`) (Vaultier now maps discovery/preflight adapter failures into deterministic UI error identifiers and includes deterministic Tauri bridge parity assertions for discovery/flush/safe-eject/command failure paths in `vaultier/src/lib/runtimeBridge.test.ts`; the Tauri runtime adapter now emits explicit utility-command `status` + `error_id` fields including `mount_unwritable`, `insufficient_space`, `path_invalid`, `flush_incomplete`, and `media_unavailable` for `flush_vault_writes`/`safe_eject_media`; full OS-native adapter parity and cross-platform fixture evidence remain pending).
- [~] Add tests for Linux/macOS/Windows path-shape normalization and cross-platform error parity. (Tauri bridge now includes deterministic removable-path-shape coverage for Linux `/media|/mnt`, macOS `/Volumes`, and Windows drive-letter mount forms in `wallet/desktop/src-tauri/src/backup_bridge.rs`; cross-platform runtime error-parity fixture execution remains pending.)
- [~] Persist non-secret profile metadata (`portable_label`, `created_at`, `last_verified_at`, `schema_version`) in app-local settings. (Vaultier now persists portable profile metadata in local settings via `savePortableProfile`/`loadPortableProfile`; remaining work is desktop runtime parity coverage.)
- [~] Add CI smoke workflow that runs create/add-slot/export/verify/restore against ephemeral temp volumes per OS runner. (Added `vaultier-desktop-smoke.yml` OS-matrix smoke gate running WB-mode/headless contract flows on Linux/macOS/Windows; ephemeral temp-volume runtime adapter coverage remains pending.)
- [ ] Produce signed/nightly artifacts with reproducible build metadata attached to release notes.
- [ ] PR-F1 through PR-F5 merged with green cross-platform smoke checks.
