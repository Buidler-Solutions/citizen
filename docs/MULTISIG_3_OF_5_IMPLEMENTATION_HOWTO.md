# 3-of-5 Multisig Implementation HOWTO (Builder Credit Grants)

## Purpose

This guide documents the **technical implementation** of a 3-of-5 multisig flow
for `builder.credits` grant issuance using
`MULTISIG_CREDIT_GRANT`.

It is intended for:

- protocol operators maintaining policy configuration,
- backend engineers building signing services, and
- security reviewers validating deterministic behavior.

---

## 1) What "3-of-5" means in CITIZEN

For builder credit grants:

- `required_grant_approvals = 3`
- `grant_approvers` contains **exactly 5** approved signer identities
- every proof must bind:
  - approver id,
  - approver public key,
  - approver signature over the deterministic grant message

The ledger accepts the grant only when at least 3 **unique**, **authorized**,
and **cryptographically valid** proofs are present.

---

## 2) Ledger-enforced invariants (must pass)

The `builder.credits` namespace policy enforces the following:

1. `payload.amount` must be numeric and greater than zero.
2. `CREDIT_GRANT` is rejected for grants; use `MULTISIG_CREDIT_GRANT` or
   `PROGRAMMABLE_CREDIT_GRANT`.
3. `grant_approvers` must exist in policy config, each entry containing:
   - `id` (string),
   - `public_key` (string hex),
   - unique `id` values.
4. `required_grant_approvals` must be in the range
   `1..=grant_approvers.len()`.
5. `payload.multisig_proofs` is mandatory for `MULTISIG_CREDIT_GRANT`.
6. Every proof must include `approver`, `public_key`, and `signature`.
7. Proof approvers must be allowlisted in `grant_approvers`.
8. Proof `public_key` must exactly match the configured key for that approver.
9. Signature verification must succeed against the deterministic signing payload.
10. Unique valid approvals must be at least `required_grant_approvals`.

---

## 3) Reference 3-of-5 policy configuration

Use this policy object under the governed namespace config for
`builder.credits`:

```json
{
  "required_grant_approvals": 3,
  "grant_approvers": [
    { "id": "grant:ops-1", "public_key": "<HEX_PUBKEY_1>" },
    { "id": "grant:ops-2", "public_key": "<HEX_PUBKEY_2>" },
    { "id": "grant:ops-3", "public_key": "<HEX_PUBKEY_3>" },
    { "id": "grant:ops-4", "public_key": "<HEX_PUBKEY_4>" },
    { "id": "grant:ops-5", "public_key": "<HEX_PUBKEY_5>" }
  ]
}
```

Operational guidance:

- Keep approver IDs stable (`grant:ops-*`) across key rotations.
- Rotate keys by governance update and staged signer rollout, not ad hoc edits.
- Prefer dedicated grant keys isolated from validator consensus keys.

---

## 4) Deterministic signing payload (exact fields)

For each approver proof, the signature must be generated over the JSON string
of the following object:

```json
{
  "entry_id": "<entry_id>",
  "namespace": "builder.credits",
  "action": "MULTISIG_CREDIT_GRANT",
  "object_id": "<builder_id>",
  "author": "<author_did>",
  "amount": 1000,
  "timestamp": 1736500000,
  "approver": "grant:ops-1"
}
```

Notes:

- `approver` is part of the signed payload, so each approver signs a unique
  message.
- The message must reflect the final entry fields (`entry_id`, `timestamp`,
  `amount`, etc.). If any field changes, signatures are invalid.
- Signatures are hex-encoded in `payload.multisig_proofs[*].signature`.

---

## 5) End-to-end implementation flow

### Step A — Build the unsigned grant entry template

```json
{
  "entry_id": "0f6db8de-c8b0-46b3-b3d4-b2e84f96f001",
  "namespace": "builder.credits",
  "action": "MULTISIG_CREDIT_GRANT",
  "object_id": "builder:acme-studio",
  "payload": {
    "amount": 2500,
    "multisig_proofs": []
  },
  "author": "did:ledger:grant-orchestrator",
  "signature": "<author_signature>",
  "timestamp": 1736500000
}
```

### Step B — Create per-approver signing messages

For each chosen approver (any 3 of the 5 allowlisted operators), create the
deterministic message described in Section 4.

### Step C — Collect signatures from signer service or HSM/TPM

The signer for `grant:ops-1` returns:

```json
{
  "approver": "grant:ops-1",
  "public_key": "<HEX_PUBKEY_1>",
  "signature": "<HEX_SIGNATURE_1>"
}
```

Repeat for at least two more unique approvers.

### Step D — Attach proofs and submit

```json
{
  "amount": 2500,
  "multisig_proofs": [
    { "approver": "grant:ops-1", "public_key": "<HEX_PUBKEY_1>", "signature": "<HEX_SIGNATURE_1>" },
    { "approver": "grant:ops-3", "public_key": "<HEX_PUBKEY_3>", "signature": "<HEX_SIGNATURE_3>" },
    { "approver": "grant:ops-4", "public_key": "<HEX_PUBKEY_4>", "signature": "<HEX_SIGNATURE_4>" }
  ]
}
```

Submit through the standard entry submission endpoint.

### Step E — Verify deterministic acceptance

- Query builder credit summary endpoint to confirm credited balance increase.
- Persist receipt and multisig evidence bundle for audit.

---

## 6) Manual operations checklist (human-run)

Use this when approvals are coordinated manually:

1. Confirm the grant payload (`builder_id`, `amount`, `entry_id`, timestamp).
2. Freeze payload; do not mutate fields after sign-off starts.
3. Have 3 distinct allowlisted approvers sign their dedicated messages.
4. Validate returned proof records:
   - approver exists in allowlist,
   - public key matches policy config,
   - signature is present and hex encoded.
5. Attach proofs and submit once.
6. Archive:
   - submitted entry JSON,
   - receipt,
   - approval transcript/ticket IDs.

---

## 7) Programmatic implementation pattern (service-run)

Recommended microservice decomposition:

- **Grant Orchestrator**
  - creates immutable grant draft,
  - requests signatures from approver signer APIs,
  - assembles `multisig_proofs`,
  - submits final entry.

- **Approver Signer** (one per approver key)
  - accepts canonical message,
  - validates local policy (rate limits, ticket ID, ACL),
  - signs with dedicated key/HSM,
  - returns `{approver, public_key, signature}`.

- **Evidence Vault**
  - stores grants + proofs + receipts,
  - supports post-incident reconstruction and compliance export.

---

## 8) Common failure modes and exact causes

- `outside grant_approvers`:
  - proof contains non-allowlisted approver id.
- `public_key does not match configured key`:
  - approver id is valid, but provided key is wrong/stale.
- `signature verification failed`:
  - signing payload mismatch (often `timestamp`, `amount`, or `entry_id`).
- `requires at least 3 unique approvals`:
  - insufficient distinct valid proofs.
- `must use MULTISIG_CREDIT_GRANT`:
  - attempted `CREDIT_GRANT` action under current policy.

---

## 9) Security hardening recommendations

- Use hardware-backed approver keys where possible.
- Separate duties: entry author identity should not hold all approver keys.
- Apply short-lived approval windows and ticket binding in signer APIs.
- Enforce immutable payload hashing in approval UX to prevent drift.
- Log signer decision metadata (request ID, policy result, key fingerprint).
- Rehearse key compromise response and governance-driven key rotation.

---

## 10) Alignment notes

This HOWTO is aligned with the governance-first baseline:

- controlled, auditable approvals,
- deterministic ledger validation,
- non-transferable builder credits,
- no speculative token mechanics.
