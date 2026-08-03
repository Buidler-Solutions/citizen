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

### Lightweight alternatives

For faster local development without the full 5-node overhead:

| Mode | Script | Validators | Ports | Use case |
|------|--------|-----------|-------|----------|
| **Solo** | `scripts/run_solo.sh` | 1 | API `9081`, QUIC `9200` | API/SDK/wallet dev, fastest startup |
| **Triolet** | `scripts/run_triolet.sh` | 3 | API `8091-8093`, QUIC `9210-9212` | Minimum BFT consensus testing (quorum: 3/3) |
| **Full localnet** | `scripts/run_localnet.sh` | 5 | API `8081-8085`, QUIC `9100-9104` | Full fault-tolerance, quorum loss, Byzantine testing |

All three modes share the same QUIC TLS certificates (`config/localnet/certs/`) and use
separate data directories to avoid state collisions.

3. In another shell, issue API reads/writes against any node (e.g. using `curl`
   against `http://127.0.0.1:8081`).
4. Press `Ctrl+C` in the launcher to stop all nodes cleanly.

> `scripts/run_localnet.sh` only verifies that each node API process responds on
> `/health`. It does **not** prove QUIC peering, block replication, or consensus
> participation.


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

## Troubleshooting: "health is ok but only alpha appears to work"

If `curl http://127.0.0.1:808{1..5}/health` is green but writes/finality only
show up on one node:

1. **Treat QUIC as required for node-to-node sync in localnet.**
   - In this topology, validator replication/consensus traffic is on QUIC
     (`127.0.0.1:9100..9104`), not on the HTTP API ports.
   - If QUIC peer links fail, `/health` can still return `{ "status": "ok" }`.
2. **Run the replication checker, not only health probes.**
   - `AUTHOR_KEY_ID=<wallet_key_id> scripts/check_localnet_replication_finality.sh`
   - This verifies cross-node receipt/block convergence and replication.
3. **Inspect per-validator logs for QUIC admission or transport failures.**
   - `rg -n "quic|admission|reject|manifest|mismatch|handshake" data/validator-*.log`
4. **Quick local socket check (inside the same WSL distro).**
   - `ss -ltnp | rg ":(9100|9101|9102|9103|9104|8081|8082|8083|8084|8085)\\b"`
   - If QUIC ports are not listening, the node did not start networking
     correctly.
5. **WSL-specific caveat.**
   - If you run some components in Windows and some in WSL, `127.0.0.1` can
     point to different network namespaces. Keep all five validators in the
     same environment (all in one WSL distro, or all on Windows/native Linux),
     and use consistent addresses reachable from each process.
   - Windows firewall or endpoint security can also interfere with UDP-based
     QUIC flows; validate in-distro first before cross-host tests.

In short: for syncing validators, QUIC connectivity is essential; HTTP health
alone is only a process liveness check.

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
  api_key = "<YOUR_BUILDER_INGEST_API_KEY>"
  scopes = ["entries.submit", "envelopes.submit"]

  [[api_clients]]
  api_key = "<YOUR_OPS_ENVELOPE_API_KEY>"
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

All five validators start as `Active` — each participates in consensus,
prevotes on blocks, and serves the read API. There is no default standby
split. The `standby_only` config flag is available for operators who want
to run a node in sync-only mode, but it is opt-in and not the default.

All five share identical namespace rulesets and admit one another by verifying
key. Replace these values with your institution keys and endpoint coordinates to
create a production-ready manifest.
