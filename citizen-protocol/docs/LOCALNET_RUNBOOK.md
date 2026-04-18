# Citizen Localnet to Production Hand-off

This runbook packages the minimum artifacts needed to stand up a five-validator
Citizen network on a single host using the QUIC transport (no mock network),
mirroring the production topology. It is meant to be reproducible so operators
can swap in their own keys, ports, and namespaces when moving to real
infrastructure.

## What's Included

- Deterministic validator configs under `config/localnet/` with pre-seeded
  signing keys and admission allowlists for the other four peers.
- Namespace rulesets for `identity.citizen`, `registry.land`,
  `audit.procurement`, and `governance.vote` with signature checks and
  double-spend prevention for the land registry.
- A launcher script (`scripts/run_localnet.sh`) that starts all five nodes with
  QUIC enabled, persists to separate RocksDB folders, and tails logs to the
  `data/` directory.

## Quickstart

1. Install Rust (`rustup`) and ensure `cargo` is on your `PATH`.
2. From `citizen-protocol/`, start the validators:

   ```bash
   scripts/run_localnet.sh
   ```

   - Ports: QUIC listeners on `127.0.0.1:9100-9104`, HTTP APIs on
     `127.0.0.1:8081-8085`.
   - Logs: `data/validator-alpha.log`, `data/validator-beta.log`,
     `data/validator-gamma.log`,
     `data/validator-delta.log`, `data/validator-epsilon.log`.
   - Data: RocksDB state under `data/alpha|beta|gamma|delta|epsilon/`.

3. In another shell, issue API reads/writes against any node (e.g. using `curl`
   against `http://127.0.0.1:8081`).
4. Press `Ctrl+C` in the launcher to stop all nodes cleanly.


## Confirm all five validators are working (and roles are correct)

With localnet running, execute:

```bash
AUTHOR_KEY_ID=<wallet_key_id> scripts/check_localnet_replication_finality.sh
```

The script verifies:

1. all five API endpoints are healthy (`8081..8085`),
2. a valid `builder.credits` grant is available (auto-bootstrapped with localnet 3-of-5 sample proofs when missing),
3. real signed `forms.commitment` entries finalize with deterministic receipts,
4. receipt status + block height converge on all five validators,
5. submitted objects replicate to all five validators, and
6. commit proof participants (active voters) vs standby syncing validators are reported.

This is the safest operator-facing check for “5 validators up + doing their respective tasks” before deeper chaos/failover drills.

If you previously saw `400 Bad Request` on `/api/v1/envelopes/submit`, ensure your payload includes `forms.commitment` required fields (`data_hash`, `encrypted_form_url`) plus `credit_grant_id`, `sponsor_builder_id`, and `author_public_key`, with `author = forms.commitment`. The checker now auto-bootstraps (or reuses) a localnet builder grant unless `AUTO_BOOTSTRAP_CREDIT_GRANT=false`.

If your local policy differs from the sample 3-of-5 approver set, pass `BUILDER_CREDIT_POLICY_JSON` to override proof validation policy used by the checker bootstrap step.

If you explicitly want to bypass grant bootstrap/linkage in permissive local profiles, run with `DISABLE_CREDIT_GRANT=true`.

The checker now cross-checks `AUTHOR_PUBLIC_KEY_HEX` against the wallet record for `AUTHOR_KEY_ID` and prefers the wallet-derived key if they differ.

The checker submits through `API_SUBMIT_ENDPOINT` (default `/api/v1/entries/submit`) and now auto-shapes request payloads for either `/api/v1/entries/submit` or `/api/v1/envelopes/submit`.

## Adapting to Production

- **Replace signing keys**: swap `signing_key_hex` in each config with HSM-backed
  or otherwise managed Ed25519 keys. The node will derive the verifying key and
  advertise it over QUIC.
- **Update admission allowlist**: edit each `[[validators]]` table so every
  member has the correct verifying key and identity anchors. This controls
  handshake admission and commit proof verification.
- **Change bind addresses**: set `bind_addr` and `api_port` to routable
  interfaces. Keep ports unique per validator.
- **Adjust quorum/timeouts**: tune `quorum_bps` and `block_time_millis` if your
  operator set or latency profile differs from the defaults.
- **Namespace governance**: update `descriptor.rules_hash` and `governed_by` to
  reflect your published governance policy and rule versions. Writers can be
  narrowed to production-grade issuers.
- **Observability**: run with `RUST_LOG=info` (or `debug`) and ship the
  resulting `data/*.log` files to your log pipeline. CPU/RAM and block timing
  can be derived from these logs or external monitors.

- **API edge controls (required before public writes)**: enable node-side edge
  policy for submission endpoints using API keys, scoped authorization, and rate
  limits:

  ```toml
  api_auth_required = true
  api_max_write_requests_per_minute = 120

  [[api_clients]]
  api_key = "builder-ingest-key"
  scopes = ["entries.submit", "envelopes.submit"]

  [[api_clients]]
  api_key = "ops-envelope-key"
  scopes = ["envelopes.submit"]
  ```

  - `/api/v1/entries/submit` requires `entries.submit`.
  - `/api/v1/envelopes/submit` requires `envelopes.submit`.
  - Offchain write routes (`/api/v1/files/commit`, `/api/v1/payloads/commit`, `/api/v1/files/revoke`) also enforce builder-credit linkage on their embedded envelope payload before ledger admission.
  - All write submissions that carry ledger entries must include `payload.credit_grant_id` referencing an active `builder.credits` grant for `payload.sponsor_builder_id` (or `entry.author` when `sponsor_builder_id` is omitted).
  - Only grant-issuance bootstrap actions (`MULTISIG_CREDIT_GRANT` / `PROGRAMMABLE_CREDIT_GRANT` in `builder.credits`) are exempt from needing a pre-existing `credit_grant_id`.
  - Missing/invalid keys return `401`; missing scopes return `403`; over-limit
    clients receive `429`.

## Config Reference

- `config/localnet/validator-alpha.toml` – uses signing key
  `1f1e...020100`, binds `127.0.0.1:9100`, API `8081`.
- `config/localnet/validator-beta.toml` – uses signing key
  `2f2e...13121110`, binds `127.0.0.1:9101`, API `8082`.
- `config/localnet/validator-gamma.toml` – uses signing key
  `3f3e...23222120`, binds `127.0.0.1:9102`, API `8083`.

- `config/localnet/validator-delta.toml` – uses signing key
  `e48c...6c6a69`, binds `127.0.0.1:9103`, API `8084`.
- `config/localnet/validator-epsilon.toml` – uses signing key
  `ed71...ae9bc7`, binds `127.0.0.1:9104`, API `8085`.

The localnet bootstrap snapshot intentionally models a 200% validator list: the
first half (rounded up) starts as `Active` and the remainder starts as `Standby`.
Standby validators sync blocks but do not prevote until liveness rotation
promotes them.

All five share identical namespace rulesets and admit one another by verifying
key. Replace these values with your institution keys and endpoint coordinates to
create a production-ready manifest.
