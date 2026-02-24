# Validator Runbook: Issue an API Key to a Builder

## Purpose

This runbook defines the operational process for a validator operator to issue,
activate, verify, rotate, and revoke a builder API key used for write ingress to
Citizen node endpoints.

The API key is an **ingress identity + scope control**, not economic
authorization. Builder write capacity must still be enforced by on-ledger credit
grant policy (`credit_grant_id` checks and builder credit namespace rules).

## Scope

Use this procedure when a validator grants a builder access to write endpoints
such as:

- `POST /api/v1/entries/submit` (`entries.submit` scope)
- `POST /api/v1/envelopes/submit` (`envelopes.submit` scope)

## Preconditions

1. Builder identity has been verified through your governance-approved process
   (organization, DID, contact channel, and intended namespace usage).
2. Builder has an approved integration profile (environments, rate target,
   required scopes, and sponsoring model).
3. Operator has secure secret handling available (vault/HSM/secret manager).
4. Node config management path is available for controlled deployment.

## Security Baseline

- Generate high-entropy API keys (at least 32 random bytes).
- Store the cleartext key only in approved secret storage.
- Do not send keys in plaintext chat/email.
- Issue least-privilege scopes only.
- Set a rotation date at issuance time.

## Step 1 — Build an issuance record

Create an internal issuance ticket containing:

- Builder ID (for example `did:builder:acme`).
- Environment (`testnet`, `staging`, `mainnet`).
- Required scopes (`entries.submit`, `envelopes.submit`, etc.).
- Rate-limit target (writes/minute).
- Key owner and emergency contact.
- Planned expiry/rotation date.

## Step 2 — Generate a key

Example (hex-encoded 32-byte token):

```bash
openssl rand -hex 32
```

Recommended naming pattern in secret storage:

`citizen/<network>/<builder_id>/api-write-key/<version>`

## Step 3 — Configure node API edge policy

Update the validator config TOML:

```toml
api_auth_required = true
api_max_write_requests_per_minute = 120

[[api_clients]]
api_key = "<generated-secret>"
scopes = ["entries.submit", "envelopes.submit"]
```

Notes:

- Keep `api_auth_required = true` for public/builder write exposure.
- Add only the scopes required for the builder use case.
- If multiple builders exist, add one `[[api_clients]]` block per key.

## Step 4 — Deploy safely

1. Commit config changes through your controlled ops repo/process.
2. Roll out node config to validator(s) in the target environment.
3. Restart/reload the node process according to your service manager.
4. Confirm node health and block participation after rollout.

## Step 5 — Deliver key to builder securely

Use one of:

- Secret manager access policy grant to builder integration team.
- Time-limited secure secret-sharing channel.

Deliver with a minimum integration packet:

- API base URL.
- Required header: `x-api-key: <secret>`.
- Allowed scopes and endpoints.
- Rate limits and expected 401/403/429 behavior.
- Rotation date and revocation contact path.

## Step 6 — Validate issuance

Run smoke checks after rollout.

### 6.1 Missing key must fail

```bash
curl -i -X POST "http://<node-host>:<api-port>/api/v1/entries/submit" \
  -H "content-type: application/json" \
  -d '{}'
```

Expected: `401`.

### 6.2 Invalid key must fail

```bash
curl -i -X POST "http://<node-host>:<api-port>/api/v1/entries/submit" \
  -H "content-type: application/json" \
  -H "x-api-key: invalid-key" \
  -d '{}'
```

Expected: `401`.

### 6.3 Valid key + wrong scope must fail

Call an endpoint not covered by the issued scopes.

Expected: `403`.

### 6.4 Valid key + allowed scope reaches policy layer

Submit a syntactically valid request to an allowed endpoint.

Expected: request passes API-key check and is then accepted/rejected by ledger
policy (for example credit-grant validation).

## Rotation Runbook

1. Generate replacement key (`v+1`).
2. Add new key in config while keeping old key active briefly.
3. Notify builder to switch by cutover time.
4. Remove old key from `[[api_clients]]`.
5. Redeploy and verify old key now returns `401`.

## Emergency Revocation

Trigger conditions:

- Key leakage/suspected compromise.
- Builder integration breach.
- Policy or governance-directed suspension.

Actions:

1. Remove compromised key from `[[api_clients]]`.
2. Redeploy validator API config immediately.
3. Verify revoked key returns `401`.
4. Issue replacement key only after incident containment.
5. Record incident timeline and governance notifications.

## Audit Checklist

For each issuance, retain:

- Issuance ticket/reference ID.
- Builder identity and approved scopes.
- Hash/fingerprint of issued key material (not cleartext).
- Issued-at, rotate-by, revoked-at (if applicable).
- Operator approver identity.
- Post-issuance validation evidence (`401/403/allowed-path` checks).

## Alignment Notes

- API keys authenticate client ingress and enforce coarse authorization/rate
  limiting.
- On-ledger grant policy remains mandatory for write economics and sponsorship
  authorization.
- This split preserves builder-first UX while maintaining deterministic,
  auditable enforcement boundaries.
