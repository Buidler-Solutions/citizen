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
