# Genesis Hashing & Runtime Bring-Up Runbook (Citizen Protocol)

This runbook is a complete operator guide for deriving, validating, and enforcing
`genesis_hash` so a Citizen Protocol runtime can start cleanly and join peers
without network-identity rejection.

It expands the minimal checklist into a full lifecycle:

1. prepare trusted genesis and manifest inputs,
2. derive canonical hash evidence,
3. build and sign the admission manifest,
4. configure node runtime enforcement,
5. validate startup preflight and cross-peer identity parity,
6. resolve failures and execute controlled identity transitions.

`genesis_hash` is a mandatory network-identity input and must remain consistent
across local storage, manifest payload, and peer handshake identity.

---

## 1) Why `genesis_hash` is a hard runtime gate

Citizen startup admission and transport admission bind runtime identity to:

- `network_id`
- `genesis_hash`
- `manifest_digest`

A mismatch in any field causes deterministic rejection of startup and/or peer
admission to prevent accidental cross-network peering and malicious replay.

---

## 2) Runtime source of truth (implementation-aligned)

At startup preflight, local genesis hash is computed from storage:

1. read block at height `1`,
2. if present, hash only deterministic header fields,
3. if absent, use `blake3("GENESIS::EMPTY")`.

Header hash function (`hash_block_header`) uses SHA-256 over this exact order:

1. `height` (big-endian bytes)
2. `prev_hash` (UTF-8 bytes)
3. `entry_root` (UTF-8 bytes)
4. `proposer` (UTF-8 bytes)
5. `timestamp` (big-endian bytes)

`commit_proof` is intentionally excluded so the hash is stable before/after
signature aggregation.

### Important implementation note

The fallback `GENESIS::EMPTY` hash is deterministic and valid only for nodes
with no height-1 block yet. For shared testnet/futurenet/mainnet-like startup,
operators should still bootstrap from approved genesis artifacts and avoid
assuming empty-state fallback equals approved network genesis.

---

## 3) Prerequisites for production-safe derivation

Before touching manifests, ensure you have:

- governance-approved genesis artifact/snapshot for the target network,
- trusted node config template with real key material (no placeholders),
- draft `manifest.payload.json`,
- approved signer key(s) for manifest signatures,
- one reference node host (or isolated VM/container) for canonical preflight
  evidence capture.

Tooling:

- `cargo` (if running through workspace),
- runtime binary (`citizen-node`) or `cargo run` path,
- `openssl` (manifest helper key-id derivation/signing flow),
- `jq` (recommended for JSON evidence checks).

---

## 4) End-to-end operator procedure

## Phase A — Bootstrap trusted reference node

1. Start from clean data dir (or audited trusted snapshot).
2. Launch node against intended network config.
3. Ensure node reaches startup preflight phase.

From monorepo root (example testnet profile):

```bash
RUST_LOG=info cargo run --release -p citizen-node --manifest-path citizen-protocol/Cargo.toml -- citizen-protocol/config/testnet/validator-sample.toml
```

Prebuilt binary form:

```bash
RUST_LOG=info ./citizen-node /etc/citizen/node.toml
```

If config has `manifest_path`, path must resolve from process working directory
or be absolute.

## Phase B — Capture canonical `genesis_hash` evidence

Capture from startup preflight diagnostics/logs on the trusted reference node.
Store evidence records with:

- node hostname/instance id,
- timestamp (UTC),
- `network_id`,
- derived local `genesis_hash`,
- manifest digest (if present),
- validator id / node role,
- config commit/version provenance.

Operational best practice: capture at least two independent trusted nodes and
compare values before manifest publication.

## Phase C — Update manifest payload

Set exact canonical hash in payload:

```json
{
  "genesis_hash": "<CANONICAL_GENESIS_HASH_HEX>"
}
```

Also ensure payload has required fields:

- `network_id`
- `genesis_hash`
- `boot_nodes`
- `validator_allowlist`
- `issued_at`
- `version`
- `manifest_id`

## Phase D — Sign manifest with approved keys

Example helper command:

```bash
scripts/generate_signed_manifest.sh --payload ./manifest.payload.json --private-key ./manifest-signer-ed25519.pem --key-id "$(openssl pkey -in ./manifest-signer-ed25519.pem -pubout -outform DER | tail -c 32 | od -An -v -tx1 | tr -d ' \n')" --output ./signed-manifest.json
```

Treat signed manifest as controlled release artifact:

- immutable checksum published to operators,
- signer key provenance recorded,
- issuance timestamp verified against policy windows.

## Phase E — Enforce manifest in every node config

Set in each node configuration:

```toml
manifest_enforce = true
manifest_path = "/absolute/path/to/signed-manifest.json"
```

Do not leave sample placeholder values such as
`REPLACE_WITH_SIGNED_MANIFEST_JSON_PATH`.

## Phase F — Startup preflight validation

Restart nodes and validate startup passes with no mismatch reason codes.

Required clean-state expectations:

- no `manifest_genesis_mismatch`,
- no `local_genesis_mismatch`,
- no `manifest_network_mismatch`,
- no `manifest_required` / `manifest_path_placeholder`.

## Phase G — Cross-peer identity tuple parity checks

Across at least two peers per region/cluster, confirm tuple parity:

- `network_id`
- `genesis_hash`
- `manifest_digest`

Any disparity means network identity split risk; halt rollout until reconciled.

---

## 5) Runtime completion criteria (what “running” means)

A Citizen runtime is considered correctly brought up when all are true:

1. Node startup preflight succeeds under `manifest_enforce = true`.
2. Each node reports same `network_id` and `genesis_hash`.
3. Each peering node presents same `manifest_digest` identity component.
4. Peers admit each other without identity mismatch rejection.
5. Block production/verification continues after admission stage.

This runbook covers identity bring-up gates; pair with network and validator
readiness runbooks for full production acceptance.

---

## 6) Failure reason map and deterministic remediation

## `manifest_genesis_mismatch`

Meaning:
- Signed manifest `payload.genesis_hash` differs from runtime expected genesis.

Remediation:
1. Re-verify approved genesis artifact provenance.
2. Re-capture canonical hash from trusted preflight evidence.
3. Patch `manifest.payload.json`.
4. Re-sign and redeploy manifest.
5. Restart and re-verify.

## `local_genesis_mismatch`

Meaning:
- Local storage hash differs from expected genesis in admission context.

Remediation:
1. Quarantine node data dir immediately.
2. Restore from trusted snapshot or re-bootstrap from approved genesis.
3. Re-run preflight and compare tuple values.

## `manifest_network_mismatch`

Meaning:
- Manifest `network_id` differs from configured runtime `network_id`.

Remediation:
1. Validate operator config target network.
2. Validate signed manifest artifact distribution channel.
3. Align config/manifest pair and restart.

## `manifest_required`

Meaning:
- `manifest_enforce=true` without usable manifest.

Remediation:
1. Ensure manifest file exists/readable.
2. Set valid absolute `manifest_path`.
3. Restart and verify.

## `manifest_path_placeholder`

Meaning:
- Sample placeholder path still present in config.

Remediation:
1. Replace placeholder with real signed manifest path.
2. Re-run startup preflight.

## `storage`

Meaning:
- Storage read failure while deriving local genesis hash.

Remediation:
1. Check disk, file permissions, RocksDB health.
2. Repair or restore from backup.
3. Repeat preflight and tuple verification.

---

## 7) Controlled genesis identity transitions

For governance-approved resets/forks that change identity tuple:

1. secure governance approval (>=80%) for transition,
2. create new signed manifest with new (`network_id`, `genesis_hash`) pair,
3. canary validator rollout,
4. observer rollout,
5. full validator rollout,
6. retain rollback artifacts for previous tuple until closure criteria are met.

Never perform ad-hoc genesis identity changes outside governance process.

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

## 9) Expanded operational evidence checklist (recommended)

- [ ] Manifest checksum published via trusted release channel.
- [ ] Signer key-id and approval ticket linked in ops record.
- [ ] At least two-node independent genesis hash confirmation archived.
- [ ] Rollout batch report includes tuple parity snapshots.
- [ ] Incident rollback package includes prior signed manifest and snapshots.

---

## 10) Related runbooks

- `docs/ADMISSION_MANIFEST_GENERATION_HOWTO.md`
- `docs/NETWORK_ADMISSION_TROUBLESHOOTING_RUNBOOK.md`
- `docs/NETWORK_IDENTITY_CHANGE_RUNBOOK.md`
- `docs/NODE_OPERATOR_KEYGEN_RUNBOOK.md`
- `docs/VALIDATOR_ROLLOUT_READINESS.md`
