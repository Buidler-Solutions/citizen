# ACL + DEK Implementation Double Check (Per-Field + Per-Payload Commit)

Status: ✅ Implemented and synchronized across the current Citizen ecosystem surfaces, including explicit opt-in encrypt-then-commit mode selection.

Last reviewed: 2026-02-24

## Scope

This review verifies the newly added ACL + DEK privacy implementation is reflected consistently across:

- wallet signing/encryption behavior,
- canonical entry schema and node API persistence,
- consent/commit verifiability requirements,
- builder-facing docs/runbooks for end-to-end operations.


## Privacy mode confirmation (implementation-level)

Yes — the implementation now clearly supports **opt-in encrypt-then-commit** with two protection strategies:

- **Passphrase path** (`privacy_mode = passphrase`)
- **ACL + DEK path** (`privacy_mode = hybrid`)

When encryption is not requested, the default remains:

- **Public clear-text path** (`privacy_mode = none`)

For selective disclosure in hybrid mode, field-level ACL overlays are carried via `field_reader_acls`.

### Four practical privacy options (for builders/operators)

The ecosystem documentation now treats privacy handling as four practical choices:

1. `none` — default clear-text payload (no encryption).
2. `passphrase` — full payload encrypt-then-commit with passphrase-protected access.
3. `hybrid_full_payload` — ACL + DEK encrypt-then-commit over the full protected payload.
4. `hybrid_selective_fields` — ACL + DEK encrypt-then-commit with per-field visibility controls.

> Notes:
> - Options 3 and 4 both use `privacy_mode = hybrid`; they are operational variants distinguished by whether `field_reader_acls` is applied for selective disclosure.

## Normative implementation summary

Citizen hybrid privacy mode now supports:

1. **Per-payload commit anchoring**
   - canonical payload commitment (`payload_commitment`) is always computed over canonical JSON prior to encryption.
2. **Per-field ACL control**
   - `field_reader_acls` maps fields to authorized reader DIDs for selective disclosure.
3. **DEK-based encrypted custody**
   - each encrypted submission has an entry DEK,
   - each authorized reader receives a wrapped DEK in `key_wrapped_secrets`.
4. **Deterministic verification continuity**
   - commitment + ACL metadata are part of signed entry material so node/explorer can audit integrity.

## Ecosystem synchronization matrix

| Surface | Synchronization status | Evidence to check |
| --- | --- | --- |
| Wallet core (`crates/wallet`) | ✅ Synced | Hybrid privacy mode produces commitment + ACL + wrapped DEK metadata and binds them into signed entry payloads. |
| Shared protocol types (`crates/types`) | ✅ Synced | Ledger entry schema includes `privacy_mode`, `payload_commitment`, `field_reader_acls`, and `key_wrapped_secrets`. |
| Node/API runtime | ✅ Synced | Canonical envelope + entry retrieval surfaces carry the privacy metadata for deterministic verification without exposing plaintext. |
| dApp/backend integration contract | ✅ Synced | Builder flow remains canonical-envelope based; privacy metadata is part of entry payload contract and must be forwarded unchanged. |
| Explorer/read surfaces | ✅ Synced | Receipt/entry views can display commitment + ACL metadata for auditability and policy transparency. |
| Runbooks/testing docs | ✅ Synced | Stack testing guide now includes explicit ACL + DEK spot-check commands. |

## Release gate checks (required)

Run these checks before rollout:

1. Wallet privacy tests pass for hybrid mode and selective field behavior.
2. Localnet submit/retrieve path preserves privacy fields verbatim.
3. Explorer or API read-path confirms visibility of commitment + ACL metadata.
4. Consent/receipt verification still validates against `payload_commitment` for encrypted flows.

## Operational notes

- ACL/DEK metadata is governance-auditable and commitment-verifiable.
- Off-chain encrypted payload custody remains user/builder controlled.
- On-chain/public surfaces should expose **proof metadata**, not decrypted private content.
