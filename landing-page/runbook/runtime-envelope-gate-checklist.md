# Runtime Envelope Relay Gate-by-Gate Checklist

Date: 2026-04-06  
Status: Active

This checklist is a copy/paste operator reference for submitting onboarding interest from `landing-page/backend` into Citizen runtime via `runtime_envelope` relay mode.

---

## 1) Configure landing-page backend relay env

Set these environment variables (for example in `landing-page/backend/.env`):

```bash
# Relay target
CITIZEN_SIGNED_SUBMISSION_RELAY_URL=http://127.0.0.1:8081/api/v1/envelopes/submit
CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT=runtime_envelope

# Runtime author + namespace policy alignment
CITIZEN_SIGNED_SUBMISSION_RUNTIME_AUTHOR=forms.commitment
CITIZEN_SIGNED_SUBMISSION_RUNTIME_NAMESPACE=forms.commitment
CITIZEN_SIGNED_SUBMISSION_RUNTIME_ACTION=SUBMIT_ONBOARDING_INTEREST

# Required signer key (Ed25519 PKCS#8 PEM)
CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"

# Relay retries
CITIZEN_SIGNED_SUBMISSION_RELAY_MAX_ATTEMPTS=3
CITIZEN_SIGNED_SUBMISSION_RELAY_RETRY_BACKOFF_MS=250
```

Optional local key generation:

```bash
openssl genpkey -algorithm Ed25519 -out runtime-signing-key.pem
```

---

## 2) Confirm backend relay contract mode

```bash
curl -sS http://127.0.0.1:3001/interest/signed-submission-contract | jq
```

Expected:

- `submitModel` = `frontend_signed_backend_relay`
- `relayMode` = `database_plus_network_relay`

If `relayMode` is `invalid_relay_configuration`, fix env before continuing.

---

## 3) Runtime namespace + policy alignment

Ensure runtime has a namespace/policy that matches your relay env.

For default localnet target (`forms.commitment`), the policy requires:

- writer `forms.commitment`
- validator `require_signature`
- required payload fields: `data_hash`, `encrypted_form_url`

If your runtime uses a different namespace, set:

- `CITIZEN_SIGNED_SUBMISSION_RUNTIME_NAMESPACE`
- `CITIZEN_SIGNED_SUBMISSION_RUNTIME_AUTHOR`
- `CITIZEN_SIGNED_SUBMISSION_RUNTIME_ACTION`

to values that match that namespace’s configured rules.

---

## 4) API edge gates (auth/rate/write-enabled)

Even if API auth is disabled, other API edge gates still apply.

- `write_enabled` must be true.
- Rate limit must not be exceeded.
- If `api_auth_required=true`, you must send `x-api-key` with `envelopes.submit` scope.

Localnet docs note API key auth/scopes as required before exposing public writes.

---

## 5) Envelope consistency gates

Runtime submission rejects envelopes when:

- `envelope.signer` differs from `payload.author`
- `envelope.signature` differs from `payload.signature` (when both provided)

---

## 6) Ledger admission gates

After API edge checks, runtime ledger still validates:

- namespace exists
- author is allowed by `writers`
- namespace validators pass (`require_signature`, `require_payload_fields`, etc.)

If builder-credit gate is enabled on runtime (`require_builder_credit_for_all_writes=true`), payload must include an active `credit_grant_id` (and optional `sponsor_builder_id`) consistent with on-ledger `builder.credits` state.

---

## 7) Execute the flow

1. Start runtime node (`8081`), landing backend (`3001`), frontend (`3000`).
2. Open onboarding UI and complete signed submit flow.
3. If submission fails, inspect backend error response detail and backend logs:
   - relay status code
   - trace id
   - upstream relay/runtime detail string

---

## 8) Quick troubleshooting map

- **400 from backend with relay status detail**
  - check runtime namespace/writer/action mismatch
  - check runtime key/author mismatch
  - check runtime envelope policy requirements
- **401/403 from runtime**
  - check API auth and key scopes
- **422 from runtime**
  - check namespace policy validation failures
  - check signature validity and required payload fields

