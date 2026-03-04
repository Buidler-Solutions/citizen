# Admission Manifest Generation How-To & Runbook

This guide is the end-to-end operator runbook for:

1. generating a signed admission manifest artifact, and
2. wiring it into node config with `manifest_path` while keeping
   `manifest_enforce = true`.

Use this flow for local rehearsals, testnet/futurenet rollout, and production-like
operator validation.

---

## 1) What this runbook solves

When admission controls are enabled, node startup preflight requires a valid signed
manifest. If `manifest_enforce = true` and no valid manifest is provided, startup
fails before networking/consensus begin.

This runbook gives you a repeatable sequence to avoid those failures.

---

## 2) Prerequisites

Complete key generation first (required):

- Follow `docs/NODE_OPERATOR_KEYGEN_RUNBOOK.md` to generate:
  - validator/operator keypairs (for `validator_allowlist[].public_key`), and
  - manifest signer keypair (for manifest signing).

Required tools:

- `python3`
- `openssl`
- `scripts/generate_signed_manifest.sh`

Quick checks:

```bash
python3 --version
openssl version
bash scripts/generate_signed_manifest.sh --help
```

---

## 3) Gather required inputs

> Note: key material from `docs/NODE_OPERATOR_KEYGEN_RUNBOOK.md` is mandatory input for this section.

You need four operator-controlled artifacts:

1. **Manifest payload JSON** (`manifest.payload.json`)
2. **Ed25519 private key PEM** used by your manifest signer
3. **Signer key id** (32-byte Ed25519 public key hex)
4. **Destination path** for generated signed manifest (for example, `./signed-manifest.json`)

### Required payload fields

Your payload must include:

- `network_id`
- `genesis_hash`
- `boot_nodes`
- `validator_allowlist` (`validator_id` + `public_key` per validator)
- `issued_at`
- `version`
- `manifest_id`

### Example payload skeleton

```json
{
  "network_id": "citizen-testnet",
  "genesis_hash": "REPLACE_WITH_GENESIS_HASH",
  "boot_nodes": ["203.0.113.10:9300"],
  "validator_allowlist": [
    {
      "validator_id": "validator-alpha",
      "public_key": "REPLACE_WITH_VALIDATOR_PUBLIC_KEY_HEX"
    }
  ],
  "issued_at": 1736500000,
  "version": 1,
  "manifest_id": "testnet-2026-02-24-v1"
}
```

---

## 4) Generate signer key id (public key hex)

If you already have a signer PEM (`manifest-signer-ed25519.pem`), derive its key id:

```bash
KEY_ID="$(openssl pkey -in ./manifest-signer-ed25519.pem -pubout -outform DER | tail -c 32 | od -An -v -tx1 | tr -d ' \n')"
echo "$KEY_ID"
```

Expected: 64 hex characters.

Optional validation:

```bash
echo "$KEY_ID" | rg '^[0-9a-f]{64}$'
```

---

## 5) Generate the signed manifest

Run the helper script:

```bash
scripts/generate_signed_manifest.sh \
  --payload ./manifest.payload.json \
  --private-key ./manifest-signer-ed25519.pem \
  --key-id "$KEY_ID" \
  --output ./signed-manifest.json
```

### What the script does

- Canonicalizes payload JSON (deterministic ordering + compact separators).
- Signs canonical bytes with Ed25519.
- Emits a document in this exact envelope:

```json
{
  "payload": { "...": "..." },
  "signatures": [
    {
      "key_id": "<hex public key>",
      "algorithm": "ed25519",
      "signature": "<hex signature>"
    }
  ]
}
```

---

## 6) Validate generated artifact before rollout

### 6.1 Structural sanity check

```bash
python3 -m json.tool ./signed-manifest.json >/dev/null && echo "json:ok"
```

### 6.2 Required top-level keys

```bash
python3 - <<'PY'
import json
m = json.load(open('./signed-manifest.json', 'r', encoding='utf-8'))
assert 'payload' in m, 'missing payload'
assert 'signatures' in m and isinstance(m['signatures'], list) and m['signatures'], 'missing signatures'
sig = m['signatures'][0]
assert sig.get('algorithm') == 'ed25519', 'signature algorithm must be ed25519'
print('manifest:ok')
PY
```

### 6.3 Network + validator allowlist spot-check

```bash
python3 - <<'PY'
import json
p = json.load(open('./signed-manifest.json', 'r', encoding='utf-8'))['payload']
print('network_id=', p.get('network_id'))
print('validators=', len(p.get('validator_allowlist', [])))
PY
```

---

## 7) Configure node with `manifest_path`

Edit your node config (`node.toml` or network-specific config) and set:

```toml
manifest_enforce = true
manifest_path = "/absolute/path/to/signed-manifest.json"
```

Recommended:

- Use an **absolute path** so service-manager working-directory changes do not break startup.
- Ensure node process user can read this file.

If you copied from `config/*/validator-sample.toml`, replace any placeholder value
with your real signed manifest path.

---

## 8) Restart node and verify admission preflight

Restart the node and check logs for preflight success.

Example launch:

```bash
RUST_LOG=info cargo run -p citizen-node -- ./node.toml
```

What you want to see:

- no `admission preflight failed` error
- node proceeds to network/api startup

If startup succeeds, verify health/API:

```bash
curl http://127.0.0.1:8081/health
```

---

## 9) Failure triage quick map

- **`manifest_required`**: `manifest_enforce=true` but no manifest provided.
  - Fix: set `manifest_path` or disable enforcement only in approved local/dev profile.
- **`manifest_read`**: bad path/permissions.
  - Fix: validate path and file ownership/mount.
- **`manifest_path_placeholder`**: placeholder path still present.
  - Fix: replace with real signed manifest path.
- **`invalid_manifest_signature` / `untrusted_manifest_key`**:
  - Fix: regenerate with approved signer key and trusted key set.

---

## 10) Local-dev fallback (only when explicitly approved)

For local debugging only, you may disable enforcement:

```toml
manifest_enforce = false
# manifest_path removed
```

Do not use this profile for shared testnet/futurenet/mainnet operation.

---

## 11) Minimal operator checklist

- [ ] Payload fields complete and correct for target network.
- [ ] `KEY_ID` derived from the exact signer key used.
- [ ] `signed-manifest.json` generated successfully.
- [ ] `manifest_enforce = true` and valid `manifest_path` set in node config.
- [ ] Node restarted successfully without preflight errors.
- [ ] API health checks pass.

