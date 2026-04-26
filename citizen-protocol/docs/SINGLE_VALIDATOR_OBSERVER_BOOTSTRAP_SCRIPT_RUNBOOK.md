# Single Validator + Observer Bootstrap Script Runbook

This runbook documents how to use:

- `scripts/bootstrap_single_validator_observer.sh`

The script automates local bootstrap for a one-validator network plus one observer by generating a manifest payload, signing it, and patching both node config files.

---

## 1) What the script does (mechanics)

The script executes three major phases:

1. **Generate manifest payload JSON** with current `issued_at` and your provided network + validator inputs.
2. **Sign the payload** by invoking `scripts/generate_signed_manifest.sh` to create a `signed-manifest.json`.
3. **Patch node TOML configs** (validator + observer) so they both use:
   - `network_id = "<your network>"`
   - `manifest_path = "<absolute path to signed-manifest.json>"`
   - `manifest_enforce = "true"` (string value as currently implemented by this script)

Because these are patched in-place, keep backups or use git before running.

---

## 2) Requirements

### Required binaries

- `bash`
- `python3`
- `openssl`

The bootstrap script validates `python3` and `openssl` explicitly.

### Required files

You must provide these existing files:

- Validator node config TOML (`--validator-config`)
- Observer node config TOML (`--observer-config`)
- Manifest signer private key PEM (`--signer-private-key`)

### Required values

- `--genesis-hash` (canonical genesis hash your nodes should enforce)
- `--validator-public-key` (validator Ed25519 public key hex)

---

## 3) Usage reference

```bash
citizen-protocol/scripts/bootstrap_single_validator_observer.sh \
  --validator-config <validator.toml> \
  --observer-config <observer.toml> \
  --signer-private-key <manifest-signer-ed25519.pem> \
  --genesis-hash <canonical-genesis-hash> \
  --validator-public-key <validator-ed25519-public-key-hex> \
  [--validator-id <validator-id>] \
  [--network-id <network-id>] \
  [--boot-node <host:port>] \
  [--manifest-id <manifest-id>] \
  [--payload-out <manifest.payload.json>] \
  [--signed-out <signed-manifest.json>]
```

---

## 4) Argument details

### Mandatory flags

- `--validator-config`: Path to validator TOML to patch in place.
- `--observer-config`: Path to observer TOML to patch in place.
- `--signer-private-key`: Ed25519 private key PEM used to sign manifest payload.
- `--genesis-hash`: Genesis hash string embedded in payload.
- `--validator-public-key`: 32-byte Ed25519 public key hex for the allowlist validator.

### Optional flags and defaults

- `--validator-id` (default: `local-validator-1`)
- `--network-id` (default: `citizen-local`)
- `--boot-node` (default: `127.0.0.1:9300`)
- `--manifest-id` (default: `citizen-local-single-validator-v1`)
- `--payload-out` (default: `config/local/manifest.payload.json`)
- `--signed-out` (default: `config/local/signed-manifest.json`)

---

## 5) End-to-end happy-path example

From repo root:

```bash
citizen-protocol/scripts/bootstrap_single_validator_observer.sh \
  --validator-config citizen-protocol/config/testnet/validator-sample.toml \
  --observer-config citizen-protocol/config/observer/observer-public.toml \
  --signer-private-key ./manifest-signer-ed25519.pem \
  --genesis-hash sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --validator-public-key bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  --validator-id local-validator-1 \
  --network-id citizen-local \
  --boot-node 127.0.0.1:9300 \
  --manifest-id citizen-local-single-validator-v1 \
  --payload-out ./config/local/manifest.payload.json \
  --signed-out ./config/local/signed-manifest.json
```

Expected outputs:

- payload JSON generated at `--payload-out`
- signed manifest generated at `--signed-out`
- both TOML files updated
- printed follow-up commands to start nodes

---

## 6) What gets written

### Payload JSON (`--payload-out`)

The script writes:

- `network_id`
- `genesis_hash`
- `boot_nodes` (single element array from `--boot-node`)
- `validator_allowlist` with one `{ validator_id, public_key }`
- `issued_at` from `date +%s`
- `version = 1`
- `manifest_id`

### Signed manifest (`--signed-out`)

The script computes `key_id` from signer public key bytes and calls
`generate_signed_manifest.sh`, which emits:

- `payload` (canonicalized by signer helper)
- `signatures` array containing one Ed25519 signature object

### Patched TOML keys

In each target TOML, the script upserts top-level entries for:

- `network_id`
- `manifest_path`
- `manifest_enforce`

If key exists, first match is replaced; if missing, key is appended.

---

## 7) Preflight compatibility notes

To pass admission preflight with manifest enforcement:

- `manifest_enforce` must be enabled in node config.
- `manifest_path` must point to a readable signed manifest JSON.
- `network_id` in config must match manifest payload.
- `genesis_hash` in manifest must match local expected genesis.
- allowlist must include validator id/public key used by local validator runtime.

If any mismatch occurs, node startup should fail during admission checks.

---

## 8) Operational cautions

1. **Script patches files in place**.
   - Use git, or copy configs first.
2. **Absolute manifest path is written** into TOML.
   - Useful for local consistency; update if moving files across hosts.
3. **Current implementation writes** `manifest_enforce = "true"` (string literal), not TOML boolean.
   - If your parser/profile expects strict boolean, edit to `manifest_enforce = true` manually.
4. Keep signer key material private and permissions restricted.

---

## 9) Verification checklist

After running script:

1. Verify generated files exist:
   - payload path
   - signed manifest path
2. Inspect validator TOML and observer TOML:
   - `network_id` set as intended
   - `manifest_path` points to generated signed manifest
   - `manifest_enforce` set
3. Start validator, then observer.
4. Confirm observer read-only behavior:
   - health/read endpoints return success
   - write endpoints are rejected

---

## 10) Troubleshooting

### `required command not found`
Install missing binary (`python3` or `openssl`) and rerun.

### `file not found`
Check relative paths and current working directory.

### `signer helper not executable`
Ensure `citizen-protocol/scripts/generate_signed_manifest.sh` exists and is executable.

### node fails admission startup
Check, in order:

- manifest signature validity
- config `network_id` vs payload `network_id`
- payload `genesis_hash` vs local expected genesis
- allowlist includes your validator id and public key exactly
- `manifest_path` points to real file

### observer cannot replicate
Verify:

- observer has peer entry to validator
- validator bind address is reachable from observer
- both nodes use compatible `network_id`/admission parameters

---

## 11) Recommended workflow in git repos

Before running script:

```bash
git status
git add -A && git commit -m "checkpoint before bootstrap patch" || true
```

After running script:

```bash
git diff -- <validator.toml> <observer.toml>
```

Revert if needed:

```bash
git checkout -- <validator.toml> <observer.toml>
```
