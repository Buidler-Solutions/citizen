# Citizen Protocol Wallet-Signed JWT Authentication: Complete Implementation Checklist

This checklist provides an implementation-ready plan for integrating wallet-signature authentication with backend-issued JWT sessions across:
- Citizen Protocol wallet browser extension (signer-only)
- React/Next.js DApp or onboarding landing page
- Node.js + PostgreSQL backend API

It reflects the Citizen model where the wallet is only a cryptographic signer, the backend is session authority, builder infrastructure pays network fees, and sensitive user data stays off-chain.

---

## 1) System Architecture Overview

### 1.1 Component responsibilities
1. **Wallet extension (untrusted UI boundary, trusted key custody)**
   - Exposes EIP-1193-like provider interface.
   - Signs challenge payloads after explicit user approval.
   - Never stores server sessions, refresh tokens, or JWTs.
2. **Frontend (partially trusted runtime)**
   - Initiates connect + sign flow.
   - Requests challenge and exchanges signature for tokens.
   - Holds short-lived access token in memory; relies on secure refresh transport.
3. **Backend API (trusted auth authority)**
   - Generates one-time challenge nonce.
   - Verifies signature + challenge context.
   - Issues JWT access token and refresh token.
   - Maintains session state, rotation, revocation in PostgreSQL.
4. **PostgreSQL (trusted persistent state)**
   - Stores users, sessions, refresh token hash, revocation flags, device metadata.

### 1.2 Trust boundaries
1. **Private keys:** trusted only inside wallet extension secure context.
2. **JWT signing keys:** trusted only in backend secret/KMS.
3. **Browser JS environment:** treat as XSS-risky; do not persist sensitive tokens in localStorage.
4. **Transport:** all auth endpoints require HTTPS + HSTS.

### 1.3 Data flow (JWT lifecycle)
1. Frontend requests `/auth/challenge` with wallet address + context.
2. Backend creates one-time nonce/challenge, stores pending auth record with expiry.
3. Frontend asks wallet to sign challenge.
4. Frontend posts signature to `/auth/verify`.
5. Backend verifies signature/address/domain/nonce/time.
6. Backend creates session row, returns access JWT + sets refresh token cookie.
7. Frontend calls protected APIs with `Authorization: Bearer <accessToken>`.
8. On access expiry, frontend calls `/auth/refresh`; backend rotates refresh token + returns new access token.
9. On logout or compromise, backend revokes session; refresh and future access are denied.

---

## 2) Wallet Extension Requirements

### 2.1 Provider injection checklist
1. Inject provider on `window.ctzn`.
2. Provide compatibility alias on `window.ethereum` only if conflict-safe and user enabled.
3. Support EIP-1193-style `provider.request({ method, params })`.
4. Emit standard events: `accountsChanged`, `chainChanged`, `disconnect`.
5. Enforce origin-aware permission model (per-site account authorization).

### 2.2 Required methods checklist
1. `requestAccounts`
   - Prompt user to authorize account exposure per origin.
   - Return array of addresses.
2. `personal_sign`
   - Accept raw challenge string or hex.
   - Display readable message preview + domain + nonce excerpt.
3. `signTypedData` (optional but recommended)
   - Prefer EIP-712 for structured challenge binding.
   - Show typed fields clearly (domain, nonce, issuedAt, expiration).

### 2.3 Key custody + approval UX checklist
1. Private key never leaves extension process/storage enclave.
2. Every signing action requires explicit user confirmation.
3. Show:
   - requesting origin/domain
   - account address
   - sign intent (“Sign in to Citizen app”, no transaction)
4. Deny silent/background signatures.

### 2.4 SIWE-like message format checklist
1. Include fields:
   - domain
   - wallet address
   - statement
   - URI (frontend origin)
   - version
   - chainId
   - nonce
   - issuedAt
   - expirationTime (short)
   - requestId/session hint
2. Canonicalize formatting to avoid signature mismatch.
3. Bind challenge to **exact frontend domain** and backend-expected audience.

**Minimal challenge example**
```text
citizen.app wants you to sign in with your wallet:
0xAbC...123

Sign in to Citizen onboarding.
URI: https://citizen.app
Version: 1
Chain ID: 1
Nonce: 7f3a2c5e9b6d4a11
Issued At: 2026-04-04T00:00:00Z
Expiration Time: 2026-04-04T00:05:00Z
Request ID: 4d2f...
```

---

## 3) Frontend (Landing Page / DApp) Implementation

### 3.1 Connect-to-auth flow checklist
1. Implement connect button:
   - detect provider (`window.ctzn` then fallback)
   - call `requestAccounts`
   - show selected address and network
2. Request challenge:
   - `POST /auth/challenge` with address + domain context
3. Trigger signature:
   - call `personal_sign` (or `signTypedData`)
4. Verify login:
   - `POST /auth/verify` with `{ challengeId, message, signature, address }`
5. Save tokens:
   - keep access token in in-memory store (React state/query cache)
   - refresh token handled by secure httpOnly cookie
6. Authenticated state:
   - attach Bearer token to API requests
   - auto-refresh on 401/expired token

### 3.2 UX flow checklist (connect → sign → authenticated)
1. Step indicator UI: **Connect wallet → Sign message → Welcome**.
2. Pre-sign explanation modal:
   - “No gas fee, no transaction, signature only.”
3. During signing:
   - show pending spinner and timeout countdown.
4. On success:
   - show session active + linked wallet.
5. Provide logout + disconnect controls independently.

### 3.3 Frontend error handling checklist
1. User rejects signature (`4001`): show non-fatal retry CTA.
2. Wallet timeout/no response: allow re-open wallet prompt.
3. Invalid signature response: invalidate local state, restart challenge.
4. Nonce expired: request new challenge automatically.
5. JWT expired and refresh failed: clear auth state, redirect to sign-in.
6. Wallet disconnected mid-session: keep backend session but mark UI “wallet disconnected”.

### 3.4 Frontend security checklist
1. Never store access token in localStorage/sessionStorage.
2. Use strict CSP (no unsafe-inline scripts where possible).
3. Sanitize any reflected wallet/domain data in UI.
4. Use same-site cookies for refresh path.
5. Prevent token leakage in logs, analytics, error trackers.

---

## 4) Backend API Implementation (Node.js)

### 4.1 Auth endpoint contract checklist

#### A) `POST /auth/challenge`
1. **Input**
   - `address` (required, checksum/normalized)
   - `domain` (required)
   - `chainId` (required)
   - optional `walletType`, `deviceInfo`
2. **Validation**
   - address format
   - domain allowlist match
   - chainId allowlist
   - per-IP and per-address rate limits
3. **Action**
   - generate cryptographically secure nonce (>= 128 bits)
   - build challenge payload (SIWE-like)
   - persist challenge row with TTL (e.g., 5 minutes), unused status
4. **Output**
   - `{ challengeId, message, expiresAt }`

#### B) `POST /auth/verify`
1. **Input**
   - `challengeId`, `message`, `signature`, `address`
2. **Validation**
   - challenge exists and not expired
   - challenge not already used
   - message exact-match with issued challenge
   - origin/domain consistency
3. **Security checks**
   - recover signer address from signature
   - compare recovered address with provided/expected address (case-insensitive normalized)
   - mark nonce as consumed atomically
4. **Action**
   - upsert user by wallet address
   - create session row + refresh token hash
   - issue access JWT
   - set refresh token in secure cookie
5. **Output**
   - `{ accessToken, tokenType: "Bearer", expiresIn, sessionId, user }`

#### C) `POST /auth/refresh`
1. **Input**
   - refresh token cookie (`rt`)
2. **Validation**
   - cookie present, signature/random format valid
   - token hash matches active session
   - not expired/revoked
3. **Action**
   - rotate refresh token (new random token + replace hash)
   - issue new access token
   - update session last_used_at/device metadata
4. **Output**
   - `{ accessToken, tokenType: "Bearer", expiresIn }`

#### D) `POST /auth/logout`
1. **Input**
   - authenticated session + refresh cookie
2. **Action**
   - mark session revoked
   - clear refresh cookie
3. **Output**
   - `{ ok: true }`

### 4.2 Signature verification checklist
1. Parse SIWE-like message fields; reject malformed structure.
2. Reconstruct canonical message bytes exactly.
3. Recover address using secp256k1-compatible recovery logic.
4. Enforce:
   - nonce single-use
   - issuedAt <= now <= expirationTime
   - domain equals expected frontend domain
   - URI/audience matches configured app URL
   - chainId in allowlist
5. Store verification audit event (success/failure reason).

### 4.3 JWT issuance checklist
1. Access JWT claims:
   - `sub` = internal user ID
   - `wallet` = normalized wallet address
   - `sessionId`
   - `iat`, `exp`, `iss`, `aud`
   - optional `scope`/`role`
2. Expiration strategy:
   - access token: 5–15 minutes
   - refresh token/session: 7–30 days (risk-based)
3. Signing method:
   - prefer RS256/EdDSA for key rotation separation
   - HS256 acceptable only with strict secret handling and single-service boundary
4. Key management:
   - rotate keys periodically
   - include `kid` in JWT header
   - maintain key rollover validation window

---

## 5) PostgreSQL Session Design

### 5.1 Schema checklist
1. `users`
   - `id` (uuid pk)
   - `wallet_address` (unique index)
   - `created_at`, `updated_at`
2. `auth_challenges`
   - `id` (uuid pk)
   - `wallet_address`
   - `nonce` (unique)
   - `message`
   - `domain`, `uri`, `chain_id`
   - `expires_at`
   - `used_at` (nullable)
3. `sessions`
   - `id` (uuid pk)
   - `user_id` (fk users)
   - `refresh_token_hash`
   - `expires_at`
   - `is_revoked` (bool)
   - `revoked_at` (nullable)
   - `created_at`, `last_used_at`
   - `ip_address`, `user_agent`, `device_id` (nullable)

### 5.2 Database constraints checklist
1. Unique index on normalized `wallet_address`.
2. Unique constraint on challenge `nonce`.
3. Partial index on active sessions (`is_revoked = false`).
4. Transactional consume of challenge (`SELECT ... FOR UPDATE`).
5. TTL cleanup jobs for expired challenges/sessions.

### 5.3 Refresh rotation + revocation checklist
1. Store only refresh token hash (Argon2id or SHA-256 + server pepper).
2. On refresh:
   - verify existing hash
   - replace with hash of new token atomically
3. Reuse detection:
   - if old refresh token seen again, revoke session family and alert.
4. Multi-device support:
   - one session per device/browser context
   - logout-all endpoint revokes all user sessions.

---

## 6) JWT + Refresh Token Flow

### 6.1 Access token lifecycle checklist
1. Mint at `/auth/verify` and `/auth/refresh`.
2. Keep TTL short (5–15 min).
3. Validate on every protected endpoint:
   - signature, `exp`, `iss`, `aud`, `sessionId` revocation status.
4. If invalid/expired, return `401` with machine-readable error code.

### 6.2 Refresh token lifecycle checklist
1. Generate high-entropy random token (>= 256 bits).
2. Set in cookie:
   - `HttpOnly`, `Secure`, `SameSite=Lax` or `Strict`
   - path limited to `/auth/refresh` (and `/auth/logout` if needed)
3. Rotate every refresh request.
4. Revoke on logout, compromise signal, or anomaly detection.

### 6.3 Storage strategy checklist
1. **Recommended:**
   - Access token in memory only
   - Refresh token in httpOnly secure cookie
2. Avoid localStorage for either token.
3. If native/mobile wrapper exists, use OS secure enclave/keystore.

---

## 7) Security Requirements (CRITICAL)

### 7.1 Web/app security checklist
1. Enforce HTTPS + HSTS + TLS modern ciphers.
2. Strict CSP; minimize inline scripts.
3. Set `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`.
4. Dependency and supply-chain scanning in CI.

### 7.2 Auth security checklist
1. Replay prevention via nonce single-use + short expiry.
2. Signature bound to domain/origin/URI.
3. Rate limit by IP, wallet, ASN, and endpoint.
4. Brute-force detection and temporary lockouts.
5. JWT audience/issuer strict validation.
6. Session revocation checks on protected routes.
7. Full audit trail for challenge issuance, verify attempts, refresh, logout.

### 7.3 CSRF/XSS checklist
1. CSRF protect refresh/logout endpoints:
   - SameSite cookies + CSRF token/double-submit as needed.
2. XSS hardening:
   - output encode all untrusted content
   - no dynamic script eval
3. Never expose refresh token to JavaScript runtime.

### 7.4 Governance-grade integrity checklist
1. Immutable auth event log stream (append-only + hash chain optional).
2. Deterministic verification rules (documented and versioned).
3. Observer-verifiable evidence:
   - log challenge ID, nonce hash, recovered address, decision code.
4. Separate signing/auth keys from application secrets.

---

## 8) Edge Cases & Failure Handling

1. **User rejects signature**
   - Return frontend state to “connected, not authenticated”.
   - Keep challenge valid until expiry or request fresh challenge.
2. **Expired nonce/challenge**
   - return `401 CHALLENGE_EXPIRED`; frontend auto-restarts challenge.
3. **Invalid signature**
   - return `401 INVALID_SIGNATURE`; increment abuse counters.
4. **Reused nonce**
   - return `409 NONCE_ALREADY_USED`; flag suspicious event.
5. **Expired JWT**
   - return `401 TOKEN_EXPIRED`; attempt refresh once, then force relogin.
6. **Revoked session**
   - return `401 SESSION_REVOKED`; clear client auth and show security message.
7. **Wallet disconnected**
   - allow active API session to continue until token expiry; require reconnect for sensitive signing actions.
8. **Chain/account changed during flow**
   - invalidate current challenge; require new challenge for new account.
9. **Clock skew**
   - allow small leeway (e.g., ±60s) for `iat`/`exp` checks.

---

## 9) UX + Consent Flow

1. Add pre-sign screen explaining:
   - no transaction
   - no gas paid by user
   - signature used for secure login only
2. Show exact domain and wallet address before prompt.
3. Use concise wallet signing text and avoid legalistic overload.
4. Display why data remains off-chain and session is backend-managed.
5. Provide transparent privacy notice + consent receipt link.
6. Minimize friction:
   - remember connected wallet selection
   - avoid repeated prompts within active session
7. Add recovery UX:
   - “Try again”, “Switch wallet”, “Use different browser profile”.

---

## 10) Optional Enhancements

1. Multi-wallet support (injected providers + account selector abstraction).
2. WalletConnect support for mobile wallet signatures.
3. Full SIWE compliance package adoption.
4. JWT scopes/roles (`onboarding:write`, `profile:read`, `admin:*`).
5. Step-up auth for privileged actions (fresh signature challenge).
6. Geo/IP/device anomaly detection and risk scoring.
7. Security audit logging pipeline (SIEM integration).
8. Hardware-backed key attestation (where available in wallet environment).
9. Session management UI (“Active devices”, remote revoke).
10. Formal verification tests for signature parser and nonce state machine.

---

## 11) Implementation Sequence (Execution Plan)

1. Define SIWE-like message spec + canonicalization tests.
2. Build wallet provider and signing UI with origin permissions.
3. Build backend challenge + verify endpoints with DB models.
4. Add JWT + refresh issuance, hash storage, rotation logic.
5. Integrate frontend connect/sign/verify flow and token middleware.
6. Implement revocation/logout and multi-device session views.
7. Add rate limiting, audit logs, abuse detection, and observability.
8. Run security tests (replay, CSRF, XSS, token theft simulation).
9. Add production hardening (key rotation, alerts, backups, runbooks).
10. Conduct governance/observer review for deterministic verification evidence.

This sequence is the recommended path to a production-grade Citizen-compatible signer-to-JWT authentication stack.

## 12) Non-Breaking Integration Plan (Existing Wallet + Landing Page)

Use this section to ensure JWT integration is additive and does **not** break the existing browser extension ↔ onboarding flow.

### 12.1 Compatibility constraints (must keep)
1. Keep existing wallet connect handshake unchanged (`requestAccounts` request/response shape).
2. Do not rename existing provider globals already used by onboarding pages; add compatibility adapters instead of replacing behavior.
3. Keep current onboarding API routes operational during migration; add `/auth/*` routes in parallel and cut over behind a feature flag.
4. Preserve current UI states and route transitions; only add auth state resolution after signature verification success.
5. Keep builder-sponsored transaction model unchanged (auth adds identity/session only; no fee-path changes).

### 12.2 Rollout sequence (safe migration)
1. Add backend JWT endpoints without removing existing onboarding endpoints.
2. Add frontend feature flag `NEXT_PUBLIC_ENABLE_JWT_AUTH` and default it to `false` in production until validation passes.
3. When flag is on, execute new flow: challenge -> sign -> verify -> JWT; when off, execute legacy flow.
4. Keep shared wallet-connect module for both paths to avoid wallet regression.
5. Enable JWT path first in staging/canary cohort, then progressive production rollout (e.g., 5%, 25%, 50%, 100%).

### 12.3 Backward-compatible API contract rules
1. Do not change existing request/response fields consumed by current frontend without versioning.
2. New auth responses should be additive (`accessToken`, `expiresIn`, `sessionId`) and never remove legacy fields during transition.
3. Return stable error envelope for both legacy and JWT paths:
   - `{ error: { code: string, message: string, retryable: boolean } }`
4. Add explicit version header support (`X-Auth-Version: jwt-v1`) for controlled cutover.

### 12.4 Regression test checklist (required before enablement)
1. Wallet connect still works on onboarding page with JWT flag off.
2. Wallet connect still works on onboarding page with JWT flag on.
3. Signature popup renders and confirms correctly for existing extension build.
4. User rejection path returns to same onboarding screen (no blank/error page).
5. Existing onboarding submission flow still works after successful JWT login.
6. Refresh flow silently renews access token; onboarding form state remains intact.
7. Logout clears JWT session but does not break reconnect/sign flow.
8. Legacy path remains functional until final deprecation milestone.

### 12.5 Observability and rollback
1. Track success/failure metrics separately for legacy and JWT paths:
   - challenge success rate
   - signature rejection rate
   - verify failure rate
   - refresh failure rate
2. Add fast rollback switch (disable JWT flag server-side and client-side).
3. If verify or refresh error rates exceed SLO, auto-fallback to legacy path for new sessions.
4. Keep migration runbook with owner, rollback criteria, and communication plan.

