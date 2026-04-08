# Citizen Localnet to Production Hand-off

This runbook packages the minimum artifacts needed to stand up a three-validator
Citizen network on a single host using the QUIC transport (no mock network),
mirroring the production topology. It is meant to be reproducible so operators
can swap in their own keys, ports, and namespaces when moving to real
infrastructure.

## What's Included

- Deterministic validator configs under `config/localnet/` with pre-seeded
  signing keys and admission allowlists for the other two peers.
- Namespace rulesets for `identity.citizen`, `registry.land`,
  `audit.procurement`, and `governance.vote` with signature checks and
  double-spend prevention for the land registry.
- A launcher script (`scripts/run_localnet.sh`) that starts all three nodes with
  QUIC enabled, persists to separate RocksDB folders, and tails logs to the
  `data/` directory.

## Quickstart

1. Install Rust (`rustup`) and ensure `cargo` is on your `PATH`.
2. From `citizen-protocol/`, start the validators:

   ```bash
   scripts/run_localnet.sh
   ```

   - Ports: QUIC listeners on `127.0.0.1:9100-9102`, HTTP APIs on
     `127.0.0.1:8081-8083`.
   - Logs: `data/validator-alpha.log`, `data/validator-beta.log`,
     `data/validator-gamma.log`.
   - Data: RocksDB state under `data/alpha|beta|gamma/`.

3. In another shell, issue API reads/writes against any node (e.g. using `curl`
   against `http://127.0.0.1:8081`).
4. Press `Ctrl+C` in the launcher to stop all nodes cleanly.

## API Ingestion Mode (Compatibility Flag)

Validator write ingestion supports two modes behind
`api_local_finalize_mode`:

- `true` (migration compatibility default): API submissions continue to finalize
  locally on the receiving validator.
- `false` (target default for consensus-backed ingestion): API submissions are
  admitted/validated at the edge and enqueued into the shared txpool for block
  proposal + consensus finality.

Recommended localnet setting for convergence testing:

```toml
api_local_finalize_mode = false
```

When this is set to `false`, operators should expect:

- `POST /api/v1/entries/submit` and `POST /api/v1/envelopes/submit` to return
  `202 Accepted` with queue diagnostics in the response body.
- Queue saturation to return `429` with `status: "queue_full"`.
- Entries submitted to one validator to become visible on other validators
  after consensus finality (rather than immediately as node-local state).

## API → Consensus Convergence Evidence Capture

To produce a timestamped artifact proving submit-to-one/read-on-all behavior,
run:

```bash
scripts/capture_api_consensus_sync_evidence.sh
```

The script will:

- build and start the three localnet validators,
- submit one entry to Alpha (`8081`) only,
- verify that the same `entry_id` is visible on Beta/Gamma,
- verify block-height parity across all validators, and
- write a report under `docs/artifacts/` containing API snapshots + log tails.

## Admission vs Ingestion Responsibility (Operator Note)

Admission and ingestion are complementary controls and both are required in
validator deployments:

- **Manifest/admission controls** determine which peers are allowed to
  participate in validator networking, handshake trust establishment, and commit
  proof verification.
- **Ingestion/consensus wiring controls** determine how API writes become
  canonical ledger state (queueing, proposal inclusion, and consensus finality).

Operationally, a strict admission allowlist alone does **not** guarantee API
write convergence. Operators must still run validator nodes with consensus-backed
ingestion (`api_local_finalize_mode = false`) and healthy queue drain/finality.

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

## Queue Health + Alerting Hooks

In consensus-backed ingestion mode (`api_local_finalize_mode = false`), include
the following checks in your operations pipeline:

- **Stuck queue detector**: alert when write traffic is present (`enqueued_total`
  increasing) but block intake is stalled (`drained_total` flat) for longer than
  two block intervals.
- **Zero-throughput detector**: alert when queue length remains above zero while
  `drained_total` remains unchanged for the same window.
- **Duplicate pressure monitor**: watch
  `enqueue_rejected_duplicate_total` for sudden jumps that may indicate client
  replay storms.
- **Capacity pressure monitor**: watch `enqueue_rejected_full_total` and HTTP
  `429 queue_full` responses; sustained growth indicates txpool capacity is too
  small for current ingress rate.

Operator playbook for alerts:

1. Confirm consensus liveness (block heights advancing on all validators).
2. Check queue telemetry from recent submit responses (`queue_len`,
   `queue_capacity`, counters).
3. Reduce ingress pressure (tighten API rate limits or temporarily gate keys) if
   queue-full rejections persist.
4. Escalate to validator incident handling if queue drain remains stalled despite
   healthy ingress and available capacity.

## Restart Semantics (Current Implementation)

The current tx ingress queue is process-local and in-memory. This has the
following operational implications:

- A validator restart clears any queued-but-not-yet-proposed entries on that
  node.
- Entries that were already committed by consensus remain durable in RocksDB and
  are restored from ledger state on restart.
- Clients should treat `202 Accepted` as "accepted for ingestion attempt" and
  retry idempotently (same `entry_id`) if commit evidence is not observed within
  the expected finality window.

Until persistent txpool storage is introduced, operators should combine:

1. conservative rolling-restart procedures,
2. submitter-side idempotent retry policy, and
3. queue/finality telemetry checks after maintenance windows.

## Config Reference

- `config/localnet/validator-alpha.toml` – uses signing key
  `1f1e...020100`, binds `127.0.0.1:9100`, API `8081`.
- `config/localnet/validator-beta.toml` – uses signing key
  `2f2e...13121110`, binds `127.0.0.1:9101`, API `8082`.
- `config/localnet/validator-gamma.toml` – uses signing key
  `3f3e...23222120`, binds `127.0.0.1:9102`, API `8083`.

All three share identical namespace rulesets and admit one another by verifying
key. Replace these values with your institution keys and endpoint coordinates to
create a production-ready manifest.
