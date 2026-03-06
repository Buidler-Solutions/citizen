# Runtime Stack (Docker)

This folder contains a minimal Docker runtime deployment for a Citizen node.

## What was reviewed

The runtime stack expected a signed admission manifest (via `manifest_path` in `node.toml`) but did not include a payload template to help operators produce one. This directory now includes:

- `manifest.payload.sample.json` — sample payload that matches the node admission manifest schema.

## Generate a signed manifest from the sample payload

1. Copy and edit the sample payload:

```bash
cp deploy/runtime-stack/manifest.payload.sample.json ./manifest.payload.json
```

2. Replace placeholders in `./manifest.payload.json`:

- `genesis_hash`
- validator `public_key`
- optionally `network_id`, `boot_nodes`, and `manifest_id`

3. Sign the payload:

```bash
scripts/generate_signed_manifest.sh \
  --payload ./manifest.payload.json \
  --private-key ./manifest-signer-ed25519.pem \
  --key-id "$(openssl pkey -in ./manifest-signer-ed25519.pem -pubout -outform DER | tail -c 32 | od -An -v -tx1 | tr -d ' \n')" \
  --output ./signed-manifest.json
```

4. Point your node config to the generated file:

```toml
manifest_enforce = true
manifest_path = "/absolute/path/to/signed-manifest.json"
```

## Runtime stack path fixes

`docker-compose.yml` and `Dockerfile` are wired so the compose build context is the repository root, and image copy paths resolve against that context.
