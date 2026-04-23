# Live Node Smoke Script — How-To

This guide explains how to run the Node.js SDK live smoke script end-to-end.

Script path:

```bash
sdk/typescript/scripts/live_node_smoke.mjs
```

## What this smoke test validates

The smoke script verifies the minimum runtime integration path:

1. Node health endpoint responds (`GET /health`).
2. SDK submits one deterministic `audit.procurement` `RECORD_EVENT` entry.
3. Submission includes `receipt.receipt_id`.
4. SDK polls receipt endpoint to terminal state (`Accepted` or `Rejected`).

## Prerequisites

- Node.js 20+ (recommended for parity with CI smoke job).
- SDK dependencies installed:

```bash
cd sdk/typescript
npm ci
```

## Mode 1: External node (default)

Use this when your CITIZEN node is already running.

```bash
CITIZEN_NODE_URL=http://127.0.0.1:8081 \
node sdk/typescript/scripts/live_node_smoke.mjs
```

## Mode 2: Local non-Docker node (cargo run)

Use this when you want the smoke script to launch the local blockchain node itself.

```bash
CITIZEN_NODE_MODE=local \
CITIZEN_LOCAL_PROTOCOL_DIR=citizen-protocol \
CITIZEN_LOCAL_CONFIG_PATH=config/localnet/validator-alpha.toml \
node sdk/typescript/scripts/live_node_smoke.mjs
```

## Mode 3: Command mode (Docker/custom runtime)

Use this when startup/shutdown requires custom commands.

```bash
CITIZEN_NODE_MODE=command \
CITIZEN_NODE_START_COMMAND="docker compose -f my-stack.yml up -d citizen-node" \
CITIZEN_NODE_STOP_COMMAND="docker compose -f my-stack.yml down" \
node sdk/typescript/scripts/live_node_smoke.mjs
```

## Environment variables

- `CITIZEN_NODE_URL` (default `http://127.0.0.1:8081`)
- `CITIZEN_NODE_MODE` (`external`, `local`, `command`; default `external`)
- `CITIZEN_LOCAL_PROTOCOL_DIR` (default `citizen-protocol`)
- `CITIZEN_LOCAL_CONFIG_PATH` (default `config/localnet/validator-alpha.toml`)
- `CITIZEN_NODE_START_COMMAND` (required for `command` mode)
- `CITIZEN_NODE_STOP_COMMAND` (optional for `command` mode)

## Expected output

On success, output includes:

- `node_mode=<mode>`
- `receipt_id=<uuid>`
- `terminal_status=Accepted` or `terminal_status=Rejected`

On failure, script prints `live_node_smoke_failed` and exits non-zero.

## Troubleshooting

- If health check times out, verify node bind address/port (`8081`) and `CITIZEN_NODE_URL`.
- If `command` mode fails immediately, validate `CITIZEN_NODE_START_COMMAND` in your shell first.
- If receipt polling times out, inspect node logs for validation or runtime errors.
