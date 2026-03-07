# Runtime Stack (Docker)

This folder contains a minimal Docker runtime deployment for a Citizen node.

## What was reviewed

The runtime stack expected a signed admission manifest (via `manifest_path` in `node.toml`) but did not include a payload template to help operators produce one. This directory now includes:

- `manifest.payload.sample.json` — sample payload that matches the node admission manifest schema.

## Signed manifest is the recommended default

For any shared, staged, or production-style runtime, keep admission enforcement
enabled:

```toml
manifest_enforce = true
manifest_path = "/absolute/path/to/signed-manifest.json"
```

Use `manifest_enforce = false` only for local/dev-only sandbox scenarios where
you explicitly accept bypassing signed admission checks.

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

4. Point your node config to the generated file (recommended default):

```toml
manifest_enforce = true
manifest_path = "/absolute/path/to/signed-manifest.json"
```

5. If running through Docker Compose, mount the signed manifest into the
   container at the same path used in `manifest_path`:

```yaml
volumes:
  - ../../config/node.toml:/etc/citizen/node.toml:ro
  - ../../config/signed-manifest.json:/etc/citizen/signed-manifest.json:ro
```


## Runbook script for Docker + signed manifest

Use the helper script to run the runtime stack with signed-manifest mounting and
container path alignment:

```bash
./deploy/runtime-stack/runbook-docker-signed-manifest.sh compose-up \
  --node-config ./config/node.toml \
  --manifest ./config/signed-manifest.json
```

The same script also supports direct `docker run` mode:

```bash
./deploy/runtime-stack/runbook-docker-signed-manifest.sh docker-run \
  --node-config ./config/node.toml \
  --manifest ./config/signed-manifest.json
```

Useful follow-up commands:

```bash
./deploy/runtime-stack/runbook-docker-signed-manifest.sh compose-down
./deploy/runtime-stack/runbook-docker-signed-manifest.sh docker-stop
```

By default, `docker-compose.yml` now accepts optional env var overrides so the
runbook can inject host/container paths:

- `NODE_CONFIG_HOST_PATH`
- `SIGNED_MANIFEST_HOST_PATH`
- `CONTAINER_NODE_CONFIG_PATH`
- `CONTAINER_MANIFEST_PATH`

## Runtime stack path fixes

`docker-compose.yml` and `Dockerfile` are wired so the compose build context is the repository root, and image copy paths resolve against that context.
