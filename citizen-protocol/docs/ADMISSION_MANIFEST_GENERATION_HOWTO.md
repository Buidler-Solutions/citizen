# Admission Manifest Generation How-To

This guide explains how to generate a signed admission manifest JSON artifact
that can be referenced by `manifest_path` when `manifest_enforce = true`.

## Prerequisites

- `python3`
- `openssl`
- `scripts/generate_signed_manifest.sh`

## Required manifest payload fields

Create a payload JSON file that includes:

- `network_id`
- `genesis_hash`
- `boot_nodes`
- `validator_allowlist` (`validator_id` + `public_key`)
- `issued_at`
- `version`
- `manifest_id`

## One-liner command

```bash
scripts/generate_signed_manifest.sh --payload ./manifest.payload.json --private-key ./manifest-signer-ed25519.pem --key-id "$(openssl pkey -in ./manifest-signer-ed25519.pem -pubout -outform DER | tail -c 32 | od -An -v -tx1 | tr -d ' \n')" --output ./signed-manifest.json
```

## What this command does

1. Derives the 32-byte Ed25519 public key from your private key and passes it as
   `--key-id` (hex-encoded).
2. Canonicalizes the payload JSON (deterministic ordering and separators).
3. Signs canonical payload bytes with Ed25519.
4. Emits `signed-manifest.json` with exact structure:

```json
{
  "payload": { ... },
  "signatures": [
    {
      "key_id": "<hex public key>",
      "algorithm": "ed25519",
      "signature": "<hex signature>"
    }
  ]
}
```

## Example payload skeleton

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

## Operator rollout

- Set `manifest_enforce = true` in node config.
- Set `manifest_path` to the generated signed manifest JSON path.
- Restart node and verify no admission preflight failure.
