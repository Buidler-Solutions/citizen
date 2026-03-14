# Runtime Stack (Docker)

This folder contains a Docker runtime deployment for a Citizen node that works in two modes:

- **Local/dev quickstart** (default): `manifest_enforce = false` using bundled sample config.
- **Shared/staged/production-style**: `manifest_enforce = true` with a real signed admission manifest.

## What changed to make Docker actually runnable

- `Dockerfile` now builds `citizen-node` in a Rust builder stage and copies the compiled binary into a slim runtime image.
- `docker-compose.yml` now defaults to files that exist inside this folder:
  - `deploy/runtime-stack/config/node.docker.toml`
  - `deploy/runtime-stack/config/signed-manifest.local.json`

This avoids the previous broken default paths (`config/node.toml`, missing `bin/citizen-node`, and missing signed manifest).

## Quickstart (local/dev)

From `citizen-protocol/`:

```bash
cd deploy/runtime-stack
docker compose up --build
```

Defaults:

- Container config path: `/etc/citizen/node.toml`
- `manifest_enforce = false` (local-only convenience)

## Shared/Staged/Production-style runtime (recommended)

For any shared network profile, keep admission enforcement enabled:

```toml
manifest_enforce = true
manifest_path = "/absolute/path/to/signed-manifest.json"
```

### Generate signed manifest

1. Copy and edit payload template:

```bash
cp deploy/runtime-stack/manifest.payload.sample.json ./manifest.payload.json
```

2. Sign payload:

```bash
scripts/generate_signed_manifest.sh \
  --payload ./manifest.payload.json \
  --private-key ./manifest-signer-ed25519.pem \
  --key-id "$(openssl pkey -in ./manifest-signer-ed25519.pem -pubout -outform DER | tail -c 32 | od -An -v -tx1 | tr -d ' \n')" \
  --output ./signed-manifest.json
```

3. Run helper script with explicit host paths:

```bash
./deploy/runtime-stack/runbook-docker-signed-manifest.sh compose-up \
  --node-config ./config/node.toml \
  --manifest ./config/signed-manifest.json
```

## Runbook helper

```bash
./deploy/runtime-stack/runbook-docker-signed-manifest.sh compose-up
./deploy/runtime-stack/runbook-docker-signed-manifest.sh compose-down
./deploy/runtime-stack/runbook-docker-signed-manifest.sh docker-run
./deploy/runtime-stack/runbook-docker-signed-manifest.sh docker-stop
```

Optional env/path overrides remain supported via:

- `NODE_CONFIG_HOST_PATH`
- `SIGNED_MANIFEST_HOST_PATH`
- `CONTAINER_NODE_CONFIG_PATH`
- `CONTAINER_MANIFEST_PATH`
