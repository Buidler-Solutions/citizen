# Observer Node Runbook

This runbook defines the dedicated watcher/observer deployment profile used after validator rollout readiness sign-off.

## Goals

- Run a read-focused node profile for builders/public operators.
- Disable consensus voting/proposer participation.
- Expose public query + verification endpoints for explorer and SDK consumers.
- Provide a reproducible bootstrap template for new observer operators.

## Runtime Profile

Set `node_role = "observer"` in the node config.

Observer behavior:

- Consensus engine does not start.
- Write endpoints are disabled (`POST /api/v1/entries/submit`, `POST /api/v1/envelopes/submit` => HTTP `403`).
- Read/query APIs remain active (`/blocks/:height`, `/entries/:namespace`, `/api/v1/receipts/:receipt_id`, DID/consent/builder-credit/asset/module/interop read paths).

Reference template:

- `config/observer/observer-public.toml`

## Bootstrap Steps

1. Copy the template and set operator-specific values:
   - `validator_id` (operator identity label)
   - `api_port`
   - `data_dir`
2. Optionally populate `[[validators]]` and `[[peers]]` from governance-approved manifests.
3. Start observer:

   ```bash
   cargo run -p citizen-node -- config/observer/observer-public.toml
   ```

4. Validate profile:

   - `GET /health` returns `200`.
   - `GET /namespaces` returns registry metadata.
   - `POST /api/v1/entries/submit` returns `403` (writes disabled).

## Public Onboarding Notes

- Builders and explorer operators should target observers for read/query traffic.
- Validator-only operational functions (signing/proposing/voting) are intentionally unavailable.
- Pair this runbook with:
  - `docs/NETWORKS.md` for staged network manifests.
  - `docs/OPERATOR_DISASTER_RECOVERY_RUNBOOK.md` for snapshot/restore drills and retention requirements.
