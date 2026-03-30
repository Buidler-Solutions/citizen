# Wallet dApp Authentication Developer Guide

## Scope

This guide is for developers integrating the Citizen browser wallet with backend-verified dApp login.

It covers:

1. extension provider methods,
2. backend challenge/verify/session lifecycle,
3. DApp API integration points,
4. production hardening practices,
5. operations and troubleshooting.

---

## Architecture Overview

Citizen wallet auth is intentionally backend-first:

1. **Web dApp** requests wallet account access.
2. **Backend** issues one-time login challenge (`nonce`, `message`, expiry).
3. **Browser wallet** signs the backend challenge (`personal_sign` or `eth_signTypedData_v4`).
4. **Backend** verifies signature + nonce + expiry + policy checks.
5. **Backend** issues short-lived signed session token.

### Components

- `wallet/browser` → injected provider + signing runtime
- `wallet/backend` → standalone wallet auth backend (challenge/verify/session)
- `dapp/apps/api` → application API also exposing auth challenge/verify endpoints

---

## Provider Integration (Browser Wallet)

### Account + chain methods

- `eth_requestAccounts`
- `eth_accounts`
- `eth_chainId`
- `wallet_switchEthereumChain`

Citizen aliases are also available for compatibility:

- `citizen_requestAccounts`
- `citizen_accounts`
- `citizen_chainId`

### Signing methods

- `personal_sign`
- `eth_signTypedData_v4`

### Optional helper

- `citizen_login` / `wallet_login` (wallet-native helper flow).  
  For strict backend-auth mode, prefer explicit backend nonce challenge + `personal_sign`.

---

## Backend API Contract

## `wallet/backend`

### `POST /auth/challenge`

Request:

```json
{
  "wallet": "0x...",
  "domain": "app.example.com",
  "uri": "https://app.example.com/login",
  "network": "futurenet"
}
```

Response:

- `challengeId`
- `nonce`
- `message`
- `issuedAt`
- `expiresAt`

### `POST /auth/verify`

Request:

```json
{
  "challengeId": "uuid",
  "wallet": "0x...",
  "signature": "0x..."
}
```

Response:

- `status: authenticated`
- `token` (JWT-compatible compact format, HS256)
- `session` metadata

### `POST /auth/session/verify`

Request: `{ "token": "..." }`  
Response: active session payload or `401`.

### `POST /auth/session/revoke`

Request: `{ "token": "..." }`  
Response: revocation confirmation.

---

## DApp API (`dapp/apps/api`) Auth Endpoints

The NestJS API also provides:

- `POST /auth/challenge`
- `POST /auth/verify`

Use this when your product architecture centralizes business logic in `apps/api` rather than using `wallet/backend` directly.

---

## Session Token Interoperability

Current backend tokens are JWT-compatible compact tokens:

- header: `alg=HS256`, `typ=JWT`, `kid=<key-id>`
- payload claims include:
  - `iss`
  - `aud`
  - `sub`
  - `sid`
  - `wallet`
  - `network`
  - `iat`
  - `exp`

Legacy 2-part tokens are still accepted for migration compatibility.

---

## Production Hardening Checklist

## Secrets and key rotation

- Never use default secret in production.
- Minimum secret length: 32+ characters.
- Prefer `AUTH_SESSION_SECRETS` with `kid:secret,kid2:secret2`.
- Rotate by prepending new key, keep old keys temporarily for verification grace period.

## Challenge policy

- One-time-use nonce.
- Strict expiry checks.
- Max verify attempts per challenge.
- Enforce wallet/challenge binding.

## Operational controls

- Per-IP rate limiting.
- Origin allowlist.
- Persisted state (challenge/session continuity across restarts).
- Audit log events for incident response.

## Session policy

- Short TTL.
- Verify endpoint validates token + persisted session + revocation + expiry.
- Revoke endpoint invalidates active token server-side.

---

## Environment Variable Reference

## Core auth

- `PORT`
- `AUTH_CHALLENGE_TTL_MS`
- `AUTH_SESSION_TTL_MS`
- `AUTH_MAX_VERIFY_ATTEMPTS`

## Rate limits

- `AUTH_RATE_LIMIT_WINDOW_MS`
- `AUTH_RATE_LIMIT_MAX`

## Session token signing

- `AUTH_SESSION_SECRET` (fallback)
- `AUTH_SESSION_SECRETS` (preferred, rotation-ready)
- `AUTH_TOKEN_ISSUER`
- `AUTH_TOKEN_AUDIENCE`

## Access control

- `AUTH_ALLOWED_ORIGINS`

---

## Implementation Notes for Contributors

1. Keep wallet challenge message deterministic and line-stable; signing payload mutations break verification.
2. Add migrations/tests when changing token claims or message format.
3. Preserve backward compatibility for at least one rollout window when changing token shape.
4. Keep replay protections in backend; never trust client-side wallet state.
5. Keep security docs in sync when introducing new provider methods.

---

## Local Validation Runbook

1. Start backend:

```bash
cd wallet/backend
npm install
npm run start
```

2. Request challenge:

```bash
curl -X POST http://127.0.0.1:4499/auth/challenge \
  -H 'content-type: application/json' \
  -d '{"wallet":"0x1234567890abcdef1234567890abcdef12345678","domain":"localhost","uri":"http://localhost:3000/login","network":"futurenet"}'
```

3. Sign returned `message` in browser wallet via dApp.
4. Verify signature:

```bash
curl -X POST http://127.0.0.1:4499/auth/verify \
  -H 'content-type: application/json' \
  -d '{"challengeId":"<id>","wallet":"0x...","signature":"0x..."}'
```

5. Verify session token:

```bash
curl -X POST http://127.0.0.1:4499/auth/session/verify \
  -H 'content-type: application/json' \
  -d '{"token":"<token>"}'
```

6. Revoke session token:

```bash
curl -X POST http://127.0.0.1:4499/auth/session/revoke \
  -H 'content-type: application/json' \
  -d '{"token":"<token>"}'
```

---

## Troubleshooting

## 401 invalid session token

- Verify `AUTH_SESSION_SECRET` / `AUTH_SESSION_SECRETS` consistency between issuing and verifying instances.
- Check `kid` exists in configured keys.

## 403 origin not allowed

- Update `AUTH_ALLOWED_ORIGINS` to include frontend origin.

## 409 challenge already consumed

- This is expected replay protection. Request a new challenge.

## 422 signature mismatch

- Confirm wallet address and message are unchanged.
- Ensure dApp signed exact backend challenge message bytes.

## repeated 429 errors

- Tune `AUTH_RATE_LIMIT_*` values to match expected traffic profile.
