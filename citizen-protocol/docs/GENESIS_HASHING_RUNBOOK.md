# Genesis Hashing Runbook (Citizen Protocol)

This runbook defines the operator workflow to derive, verify, and publish the
`genesis_hash` used in signed admission manifests when starting a
Citizen Protocol network.

`genesis_hash` is a required network-identity field and must match across:

- local node storage,
- signed admission manifest payload,
- peer handshake identity tuple.

If it does not match, startup preflight and peer admission are expected to fail.

---

## 1) Why this matters

Citizen admission controls bind network identity to:

- `network_id`
- `genesis_hash`
- `manifest_digest`

This prevents accidental or malicious cross-network peering.

---

## 2) Canonical source of truth

At runtime, the node computes local genesis hash as follows:

1. Read block at height `1` from local ledger storage.
2. If block exists, compute `hash_block_header(block.header)`.
3. If block does not exist, use `blake3("GENESIS::EMPTY")`.

`hash_block_header` is deterministic SHA-256 over these header fields in order:

- `height` (big-endian bytes)
- `prev_hash` (UTF-8 bytes)
- `entry_root` (UTF-8 bytes)
- `proposer` (UTF-8 bytes)
- `timestamp` (big-endian bytes)

`commit_proof` is intentionally excluded from hash-critical fields.

---

## 3) Prerequisites

- Finalized genesis artifact and bootstrap process for target network.
- `manifest.payload.json` draft prepared for signing.
- Access to at least one correctly bootstrapped node data directory.
- Tooling:
  - `cargo`
  - `python3`
  - `openssl` (for manifest signing flow)

---

## 4) Procedure to derive `genesis_hash`

### Step A — Bootstrap a reference node to genesis

Start a clean node once so local storage contains the canonical genesis state for
that network.

Use your normal validator/observer startup command with the intended network config.

### Step B — Read hash from node preflight context

During startup admission preflight, the node computes local genesis hash and compares
it against expected identity values. Use startup logs/diagnostics from this phase as
operator evidence.

If your organization has metrics/log collection, capture:

- local genesis hash evidence,
- manifest digest,
- configured network ID,
- node role and validator ID.

### Step C — Populate manifest payload

Set this exact value in:

```json
{
  "genesis_hash": "<CANONICAL_GENESIS_HASH_HEX>"
}
```

Then generate signed manifest artifact using the standard manifest runbook.

---

## 5) Verification gates before production start

### Gate 1 — Manifest payload correctness

Confirm `manifest.payload.json` includes:

- `network_id`
- `genesis_hash`
- `boot_nodes`
- `validator_allowlist`
- `issued_at`, `version`, `manifest_id`

### Gate 2 — Node preflight success

Run node startup with:

- `manifest_enforce = true`
- `manifest_path` set to signed manifest JSON

Expected result:

- no `manifest_genesis_mismatch`
- no `local_genesis_mismatch`
- node continues past admission preflight

### Gate 3 — Peer identity parity

Across at least two peers, confirm identity tuple parity:

- `network_id`
- `genesis_hash`
- `manifest_digest`

---

## 6) Failure map

### `manifest_genesis_mismatch`

Meaning:

- Signed manifest `payload.genesis_hash` differs from expected genesis.

Actions:

1. Reconfirm genesis provenance (correct network/bootstrap artifact).
2. Recompute/recapture canonical hash from trusted reference node.
3. Regenerate manifest payload and re-sign.
4. Redeploy manifest and restart nodes.

### `local_genesis_mismatch`

Meaning:

- Local storage genesis differs from configured/manifest expected value.

Actions:

1. Quarantine the node data directory.
2. Restore from trusted snapshot or re-bootstrap from approved genesis.
3. Restart and verify preflight.

### `storage`

Meaning:

- Storage read failed while computing local genesis hash.

Actions:

1. Check RocksDB/disk health and permissions.
2. Repair or restore data.
3. Repeat preflight checks.

---

## 7) Genesis reset / governance-driven change

When changing `genesis_hash` (for governance-approved reset/fork):

1. Obtain governance approval (>=80%) for identity transition.
2. Build new signed manifest using new (`network_id`, `genesis_hash`) tuple.
3. Canary rollout validators.
4. Roll observers.
5. Complete full validator rollout.
6. Keep rollback artifact set for previous identity tuple until transition closes.

Do not perform ad-hoc genesis identity changes outside the governance runbook.

---

## 8) Minimal operator checklist

- [ ] Reference node bootstrapped with approved genesis artifact.
- [ ] Canonical `genesis_hash` captured from trusted preflight evidence.
- [ ] `manifest.payload.json` updated with canonical `genesis_hash`.
- [ ] Signed manifest generated with approved signer keys.
- [ ] `manifest_enforce=true` and `manifest_path` configured on each node.
- [ ] Startup preflight clean (no genesis mismatch reason codes).
- [ ] Cross-peer identity tuple parity confirmed.

---

## 9) Related runbooks

- `docs/NODE_OPERATOR_KEYGEN_RUNBOOK.md`
- `docs/ADMISSION_MANIFEST_GENERATION_HOWTO.md`
- `docs/NETWORK_ADMISSION_TROUBLESHOOTING_RUNBOOK.md`
- `docs/NETWORK_IDENTITY_CHANGE_RUNBOOK.md`
