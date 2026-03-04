# Network Admission Control Implementation Plan (Guidance)

## Purpose

This plan describes how to add strict network admission control to the CITIZEN runtime so accidental cross-network peering and unauthorized runtime reuse are rejected by default.

This is **design and implementation guidance**, not production code.

## Security Objectives

1. Bind every node process to one network identity tuple:
   - `network_id`
   - `genesis_hash`
2. Require signed network manifest verification before any P2P activity.
3. Optionally require a compile-time network secret in startup and handshake admission.
4. Apply the same rules to validator and observer roles.
5. Support key/secret rotation with explicit transition windows.
6. Fail closed with explicit logging and non-zero exit code.

## Recommended Architecture Additions

### 1) Add a dedicated admission module in `crates/node`

Create a `crates/node/src/admission/` module that owns startup validation and shared identity material:

- `runtime_identity.rs`
  - compile-time constants (`RUNTIME_NETWORK_ID`, `RUNTIME_PSK_HASH`, trusted manifest pubkeys)
  - optional build-profile gating (`dev/test/prod` network IDs)
- `manifest.rs`
  - parse + canonicalize + verify manifest signatures
  - evaluate rotation policy (`old+new` in transition)
- `startup.rs`
  - run preflight checks before network initialization
  - surface typed errors mapped to process exit codes

Rationale: keep network admission logic out of `main.rs` orchestration and avoid scattering security checks.

### 2) Extend typed config in `crates/node/src/main.rs`

Current node config has role, peers, validators, and network key rotation seconds. Extend with explicit admission inputs:

- `network_id`
- `manifest_path`
- `manifest_enforce: bool` (default true for production)
- `startup_secret` (required if compile-time PSK enforcement enabled)
- optional `expected_genesis_hash` override only for controlled migration tools

Validation should happen before storage/network bring-up.

### 3) Introduce network identity material in handshake types (`crates/network/src/lib.rs`)

`PeerHandshake` currently carries validator key identity and epoch. Add non-optional identity claims:

- `network_id`
- `genesis_hash`
- `manifest_digest` (hash of canonical manifest payload)
- `psk_proof` (never raw secret; use challenge-response proof)
- handshake nonce/timestamp to prevent replay

Admission policy must reject peer messages when any identity field or cryptographic proof fails.

### 4) Add genesis commitment source of truth in ledger/state layer

Introduce one canonical method in ledger/state initialization to compute/read immutable genesis digest:

- e.g., `Ledger::genesis_hash()` backed by deterministic canonical encoding
- compare startup config + manifest expected hash + runtime genesis hash

Do not trust config strings alone; compute and compare digests from canonical genesis bytes.

## Signed Manifest Design

## Manifest schema (JSON or YAML)

Required fields:

- `network_id: string`
- `genesis_hash: string`
- `boot_nodes: [multiaddr/socket]`
- `validator_allowlist: [{validator_id, public_key}]`
- `issued_at`, `version`, `manifest_id`

Optional fields:

- metadata object (`environment`, `operator_notes`, `quorum_policy_ref`)
- rotation block/height/time window

Envelope/signature fields:

- `payload` (canonicalized bytes)
- `signatures: [{key_id, algorithm, signature}]`

Verification recommendations:

1. Canonicalize manifest payload (deterministic JSON, no field-order ambiguity).
2. Verify signatures against baked-in trusted public keys.
3. Enforce algorithm allowlist (e.g., Ed25519 only initially).
4. Enforce freshness (`issued_at` monotonic and not expired by policy).
5. Hash payload and propagate digest into handshake identity.

## Manifest key rotation policy

Use explicit key states in runtime constants:

- `ACTIVE_KEYS`
- `TRANSITION_KEYS` (old + new)
- `REVOKED_KEYS`

During transition window:

- require threshold such as `at least one old key AND at least one new key`.
- reject manifests signed only by old keys after `transition_end`.

After window closes:

- accept only active new keys
- hard reject revoked keys

## Compile-Time Secret (PSK/Passphrase) Guidance

## Avoid plain-text comparison

Instead of comparing raw secret strings, embed a compile-time root key or secret hash and use proof-of-knowledge:

- handshake challenge from receiver (nonce)
- sender computes HMAC/Blake3 keyed proof over:
  - nonce
  - `network_id`
  - `genesis_hash`
  - `manifest_digest`
- receiver recomputes and constant-time compares

Startup check:

- if PSK mode enabled, require node-supplied secret material (env/config/keystore)
- derive proof key and verify against compile-time root hash before startup proceeds

This protects against accidental mismatch and avoids sending reusable static secrets over the wire.

## Enforcement Points (Where to Wire Checks)

## A) `main()` preflight (before P2P)

In `crates/node/src/main.rs`, run admission preflight before creating `QuicNetwork` or `ConsensusEngine`:

1. Load config.
2. Load + verify manifest signature(s).
3. Compute local genesis hash from ledger/genesis source.
4. Check equality across runtime constants, config, and manifest.
5. If PSK enabled, verify startup secret material.
6. Build immutable `AdmissionContext` and only then start API/P2P/consensus.

Failure behavior:

- `tracing::error!` with precise reason code
- return error from `main` to exit non-zero

## B) Peer handshake admission (`crates/network/src/lib.rs`)

At connection accept/read path (`spawn_reader`) and outbound handshake construction (`unicast`):

- include `AdmissionContext` fields in handshake
- verify:
  - validator allowlist/public key
  - network ID equality
  - genesis hash equality
  - manifest digest equality
  - nonce-bound PSK proof
  - anti-replay timestamp/nonce cache

On failure:

- log structured rejection event
- drop stream/connection immediately
- increment admission-reject metric

## C) Genesis validation logic

Add explicit startup guard that genesis hash in manifest matches locally computed genesis commitment.

- If mismatch: do not start sync or consensus.
- If node role is observer: same enforcement path, no bypass flags.

## D) Manifest loader/verifier

Keep manifest verification independent from P2P code. It should be reusable by:

- node startup
- ops tooling (manifest lint/verify command)
- CI checks for release artifacts

## Observer Mode Requirements

Observer mode should consume the same `AdmissionContext` and `AdmissionPolicy` as validators.

No observer-specific bypasses for:

- manifest signature validity
- network/genesis match
- PSK proof
- handshake replay checks

Only consensus voting differs by role; network identity admission must remain identical.

## Fail-Safe and Operability Guidance

## Error model

Define typed admission errors (e.g., `AdmissionError`):

- `InvalidManifestSignature`
- `UntrustedManifestKey`
- `ManifestNetworkMismatch`
- `ManifestGenesisMismatch`
- `RuntimeNetworkMismatch`
- `PskVerificationFailed`
- `PeerHandshakeMismatch`
- `ReplayDetected`

Map each error to:

- structured log fields (`reason_code`, `peer_id`, `validator_id`)
- non-zero process exit code for startup failures

## Telemetry

Add counters/histograms:

- `admission_startup_fail_total{reason}`
- `admission_handshake_reject_total{reason}`
- `manifest_verification_duration_ms`
- `psk_challenge_fail_total`

This makes security policy enforcement auditable.

## Controlled Fork Process

To allow intentional forks while preventing accidental reuse:

1. Rebuild runtime with new baked constants (`network_id`, trusted manifest keys, optional PSK root).
2. Publish new genesis and signed manifest.
3. Roll validators/observers with dual-signature transition manifest if rotating keys.
4. Disable old keys after transition height/time.

A fork is therefore explicit and cryptographically governed, not an operator typo.

## Suggested Implementation Sequence

1. Introduce `AdmissionContext`, `AdmissionError`, and manifest verification module.
2. Add startup preflight in node binary and wire fail-closed exit behavior.
3. Extend `PeerHandshake` + admission checks in QUIC path (and libp2p feature path if enabled).
4. Add nonce/replay cache and PSK proof flow.
5. Add key rotation policy evaluation with old+new signature requirement.
6. Add integration tests for validator and observer startup/handshake rejection cases.

## Test Matrix (Minimum)

Startup:

- valid manifest + matching network/genesis + valid PSK => start success
- invalid signature => startup fail
- network mismatch => startup fail
- genesis mismatch => startup fail
- observer with mismatch => startup fail

Handshake:

- allowlisted validator with matching identity => accepted
- network mismatch => rejected
- genesis mismatch => rejected
- manifest digest mismatch => rejected
- invalid PSK proof => rejected
- replayed nonce/timestamp => rejected

Rotation:

- transition window: old+new signatures required and accepted
- post-window: old-only rejected, new accepted
- revoked key used => rejected
