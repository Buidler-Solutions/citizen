# Citizen Wallet Auth Backend

Minimal backend app for wallet-based dApp login flows.

For full integration and operations guidance, see:

- `wallet/docs/WALLET_DAPP_AUTH_DEVELOPER_GUIDE.md`

This app is intentionally backend-first and Citizen-protocol aware:

- issues wallet login challenges with Citizen network context,
- verifies wallet signatures server-side,
- returns backend-owned session objects,
- persists challenge/session state to disk,
- includes operational controls (rate limits, origin allowlist, audit log, revocation).

## Endpoints

- `GET /health`
- `POST /auth/challenge`
- `POST /auth/verify`
- `POST /auth/session/verify`
- `POST /auth/session/revoke`

### `POST /auth/challenge`

Request:

```json
{
  "wallet": "0xabc123...",
  "domain": "app.example.com",
  "uri": "https://app.example.com/login",
  "network": "futurenet"
}
```

Response includes `challengeId`, `nonce`, canonical `message`, and expiry timestamps.
It also includes deterministic `typedData` for optional `ctzn_signTypedData_v4` signing.

### `POST /auth/verify`

Request:

```json
{
  "challengeId": "uuid",
  "wallet": "0xabc123...",
  "signature": "0x...",
  "signatureMethod": "personal_sign | ctzn_signTypedData_v4"
}
```

If valid, returns:

- `status: authenticated`
- signed `token`
- `session` object with `sessionId`, `wallet`, `network`, and expiry fields.

## Hardening controls included

- Persistent state file: `wallet/backend/data/wallet-auth-state.json`
- Audit log: `wallet/backend/data/wallet-auth-audit.log`
- Per-IP rate limiting
- Per-challenge max verify attempts
- Origin allowlist (`AUTH_ALLOWED_ORIGINS`)
- Signed session tokens (`AUTH_SESSION_SECRET`)
- Session verify/revoke endpoints
- JWT-compatible token format (`HS256`) with `iss/aud/sub/exp` claims
- Signing-key rotation via `AUTH_SESSION_SECRETS` (`kid:secret,kid2:secret2`)

## Run

```bash
cd wallet/backend
npm install
cp .env.example .env
set -a; source .env; set +a
npm run start
```

Default port: `4499` (override with `PORT`).

If you prefer not to source `.env`, you can also run:

```bash
node --env-file=.env src/server.js
```

Important for onboarding integration:

- `NEXT_PUBLIC_WALLET_AUTH_API_URL` is set in `landing-page/frontend/.env.local`
- `AUTH_ALLOWED_ORIGINS` in `wallet/backend/.env` must include that frontend origin (host + port)

### Security environment variables

- `AUTH_SESSION_SECRET` (required in production)
- `AUTH_SESSION_SECRETS` (preferred for rotation; first key is active signer)
- `AUTH_ALLOWED_ORIGINS`
- `AUTH_CHALLENGE_TTL_MS`
- `AUTH_SESSION_TTL_MS`
- `AUTH_MAX_VERIFY_ATTEMPTS`
- `AUTH_RATE_LIMIT_WINDOW_MS`
- `AUTH_RATE_LIMIT_MAX`
- `AUTH_TOKEN_ISSUER`
- `AUTH_TOKEN_AUDIENCE`

Production policy:

- Do **not** use default secrets.
- Use at least 32+ characters per signing secret.
- Rotate keys by prepending a new `kid:secret` to `AUTH_SESSION_SECRETS` while retaining previous key(s) for verification grace period.
