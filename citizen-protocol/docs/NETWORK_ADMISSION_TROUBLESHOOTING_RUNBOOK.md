# Network Admission Troubleshooting Runbook

This runbook provides operator-facing triage for secure network admission startup
and authenticated handshake failures.

## Scope

Use this runbook when validators or observers fail to start, fail to join peers,
or exhibit repeated handshake drops tied to admission controls.

## Signals to Check First

1. Node startup logs around `admission preflight failed`.
2. Handshake warnings from network transport:
   - `quic message rejected by admission policy; closing stream`
   - `libp2p message rejected by admission policy`
3. Admission metrics snapshots:
   - `admission_startup_fail_total{reason}`
   - `admission_handshake_reject_total{reason}`
   - `psk_challenge_fail_total`
   - `manifest_verification_duration_ms`

## Startup Failure Reason-Code Triage

Map `admission_startup_fail_total{reason}` to remediation:

| reason | Meaning | Immediate remediation |
| --- | --- | --- |
| `manifest_required` | `manifest_enforce=true` but no manifest file was supplied. | Set `manifest_path` to the signed manifest or disable enforcement only in approved local/dev profiles. |
| `manifest_read` | Manifest file cannot be read (path/permissions). | Verify `manifest_path`, file ownership, and mount state. |
| `manifest_parse` | Manifest file is not valid JSON/schema. | Regenerate manifest artifact from release pipeline and redeploy. |
| `manifest_canonicalization` | Payload failed deterministic serialization. | Re-export manifest with canonical payload fields; do not hand-edit manifest JSON. |
| `invalid_manifest_signature` | Signature set does not validate over canonical payload. | Replace with signed governance artifact; verify signing key and payload digest match. |
| `untrusted_manifest_key` | Signature key ID is not in trusted runtime key set. | Rotate to governance-approved signing keys and rebuild/runtime rollout if key set changed. |
| `unsupported_manifest_algorithm` | Signature algorithm not allowed (non-ed25519). | Re-sign manifest using approved algorithm. |
| `manifest_issued_in_future` | `issued_at` exceeds allowed future skew. | Correct signer clock and reissue manifest. |
| `manifest_expired` | Manifest age exceeds policy max age. | Issue a fresh manifest and restart nodes. |
| `manifest_network_mismatch` | Manifest `network_id` differs from node config/runtime identity. | Align manifest + node config to same network (`citizen-localnet`/target network). |
| `manifest_genesis_mismatch` | Manifest genesis hash differs from expected local/network genesis. | Validate genesis artifact provenance; update manifest or re-bootstrap from correct genesis state. |
| `manifest_duplicate_validator` | Manifest allowlist repeats the same `validator_id` more than once. | Regenerate manifest with unique validator IDs; avoid manual merges that duplicate entries. |
| `manifest_allowlist_required` | Manifest enforcement is on but allowlist is empty. | Publish a signed manifest containing the complete validator allowlist before startup. |
| `runtime_network_mismatch` | Configured network ID differs from compile-time runtime network ID. | Correct `network_id` in config or deploy binary built for the intended network. |
| `psk_verification_failed` | Startup secret required but missing/invalid under PSK mode. | Provide `startup_secret` from approved secret store; verify secret rotation rollout order. |
| `local_genesis_mismatch` | Local storage genesis differs from expected genesis hash. | Quarantine node state, restore from trusted snapshot, rerun startup. |
| `storage` | Underlying storage read failed during genesis hash computation. | Check RocksDB health, disk availability, and restore from backup if corruption is detected. |

## Handshake Rejection Triage

When `admission_handshake_reject_total` rises, inspect reject reasons in logs and
validate the following matrix:

| Rejection class | Typical cause | Validation and fix |
| --- | --- | --- |
| Unknown validator | Peer validator ID not allowlisted. | Confirm peer exists in active validator snapshot/manifest allowlist. |
| Public key mismatch | Peer key no longer matches allowlist entry. | Reconcile key registry and rotate validator metadata via governance process. |
| Stale key epoch | Peer is using outdated epoch after rotation. | Restart lagging peer and verify rotation interval parity across nodes. |
| Network identity mismatch | `network_id`, `genesis_hash`, or `manifest_digest` differs between peers. | Compare handshake identity tuple across both nodes and redeploy matching manifest/genesis. |
| Invalid system time / clock skew exceeded | Clock drift exceeds admission tolerance. | Re-sync host clocks (NTP/chrony) and ensure monotonic time health. |
| Replay detected | Nonce+timestamp tuple reused (duplicate or replay). | Inspect transport retries and potential replay attempts; restart affected connection path. |
| Missing/invalid PSK proof | Peer omitted proof or used wrong secret. | Verify PSK distribution and staged rotation; confirm both peers use current secret. |



## Running Multiple Targeted Startup Tests

Cargo accepts only one positional `TESTNAME` filter. For multiple startup tests, either:

1. Use one regex filter expression:
   - `cargo test -p citizen-node "admission::startup::tests::(preflight_rejects_manifest_with_empty_allowlist|preflight_accepts_fresh_manifest)" -- --nocapture`
2. Or run each exact test sequentially with the helper script:
   - `./citizen-protocol/scripts/run_node_startup_admission_tests.sh admission::startup::tests::preflight_rejects_manifest_with_empty_allowlist admission::startup::tests::preflight_accepts_fresh_manifest`

## CI Admission Guardrail Failure Remediation

When the `Network Admission Guardrails` workflow fails:

1. Reproduce locally with `./citizen-protocol/scripts/run_admission_tests.sh` (nested layout) or `./scripts/run_admission_tests.sh` (direct layout).
2. If manifest canonicalization/digest tests fail, regenerate manifests from the release pipeline instead of hand-editing JSON payload fields.
3. If signature allowlist tests fail, ensure manifests are signed with governance-approved Ed25519 keys and that no unsupported algorithms are present.
4. If freshness/staleness tests fail, issue a new manifest with a current `issued_at` timestamp and redeploy before merging.
5. Re-run the script and include command output in the PR discussion for reviewer verification.

## Escalation & Evidence Bundle

If triage does not resolve within one on-call window:

1. Capture startup and handshake logs for a failing interval.
2. Export metrics samples for the four admission counters/timers.
3. Record manifest digest, network ID, and local genesis hash from both peers.
4. Escalate to governance/security reviewers with:
   - failing reason codes,
   - affected validator/observer IDs,
   - last known-good release artifact references.

## Post-Incident Follow-up

- Document root cause and remediation in release operations notes.
- If key/manifest process drift caused the incident, update rollout gates in:
  - `docs/VALIDATOR_ROLLOUT_READINESS.md`
  - `docs/OBSERVER_NODE_RUNBOOK.md`
- Add or extend automated tests when the incident exposes a missing admission check.
