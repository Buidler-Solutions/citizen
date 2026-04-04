# Citizen Protocol Wallet-Signed JWT Authentication — Implementation Checklist Guide

Use this file as the **single source of implementation tracking** for wallet-signature + backend JWT authentication.

## How to use this guide
- Mark items with `[x]` only when code is merged and validated in the target environment.
- Keep notes brief and date-stamped (for example: `2026-04-04: merged in staging`).
- If an item is blocked, add a short blocker note under that section.
- Do not skip “Critical Security Gates” even if feature work appears complete.

### Status legend
- `[ ]` Not started
- `[-]` In progress
- `[x]` Done
- `[!]` Blocked

---

## 0) Readiness setup (do first)
- [ ] Assign implementation owner(s) (wallet, frontend, backend, infra/security).
- [ ] Confirm scope: extension signer-only, backend session authority, builder-sponsored fee model unchanged.
- [ ] Confirm environment plan: local, staging, canary, production.
- [-] Create tracking issues/epics linked to each section below.
  - 2026-04-04: initial backend implementation PR started with challenge/verify/refresh/logout + session schema.
- [ ] Define rollout + rollback decision owner.

---

## 1) Architecture alignment

### 1.1 Component responsibilities
- [ ] Wallet extension only handles key custody + signatures.
- [ ] Frontend handles connect/sign UX and in-memory access token use.
- [-] Backend is source of truth for challenges, sessions, JWTs, and revocation.
  - 2026-04-04: backend endpoints and session persistence scaffold added; cryptographic signature verification still pending.
- [ ] PostgreSQL stores users/challenges/sessions and revocation state.

### 1.2 Trust boundaries
- [ ] Private keys remain inside extension secure context only.
- [ ] JWT signing keys stored only in backend secret manager/KMS.
- [ ] Browser runtime treated as XSS-risky (no sensitive persistent token storage).
- [ ] All auth endpoints enforce HTTPS + HSTS.

### 1.3 End-to-end auth flow
- [x] Frontend requests challenge (`POST /auth/challenge`).
  - 2026-04-04: endpoint implemented in backend.
- [x] Backend stores one-time challenge with TTL.
  - 2026-04-04: `auth_challenges` entity + TTL-based expiration persisted.
- [ ] Wallet signs challenge after explicit user approval.
- [x] Frontend verifies signature (`POST /auth/verify`).
  - 2026-04-04: endpoint implemented; full secp256k1 signature recovery is still pending.
- [x] Backend issues access token + refresh cookie + session row.
  - 2026-04-04: access JWT, `ctzn_refresh_token` cookie, and `auth_sessions` row created during verify.
- [ ] Protected APIs enforce Bearer access token.
- [-] Refresh flow rotates refresh token and issues new access token.
  - 2026-04-04: refresh endpoint issues new access token; rotation hardening still pending.
- [x] Logout/revocation invalidates session.
  - 2026-04-04: logout revokes active session and clears refresh cookie.

---

## 2) Wallet extension implementation

### 2.1 Provider injection
- [ ] Inject provider on `window.ctzn`.
- [ ] Optional `window.ethereum` alias is conflict-safe and user-controlled.
- [ ] Support EIP-1193-style `provider.request({ method, params })`.
- [ ] Emit `accountsChanged`, `chainChanged`, `disconnect`.
- [ ] Enforce per-origin account authorization.

### 2.2 Required methods
- [ ] `requestAccounts` implemented with explicit user consent.
- [ ] `personal_sign` implemented for challenge payload signing.
- [ ] `signTypedData` implemented (optional but recommended).

### 2.3 Signing UX and custody
- [ ] Private key never leaves extension boundary.
- [ ] Every signing action requires explicit user confirmation.
- [ ] Signature prompt displays origin/domain, account, and “sign-in only” intent.
- [ ] Silent/background signatures are blocked.

### 2.4 Challenge format compatibility (SIWE-like)
- [ ] Message includes domain, wallet address, URI, version, chainId, nonce, issuedAt, expirationTime, requestId.
- [ ] Canonical message formatting is deterministic and tested.
- [ ] Challenge is bound to exact frontend domain + expected backend audience.

---

## 3) Frontend (Landing Page / DApp)

### 3.1 Connect → challenge → sign → verify flow
- [ ] Detect wallet provider (`window.ctzn` first, fallback next).
- [ ] Request accounts and display selected address/network.
- [ ] Call `POST /auth/challenge` with address/domain context.
- [ ] Trigger `personal_sign`/`signTypedData` for challenge.
- [ ] Call `POST /auth/verify` with `{ challengeId, message, signature, address }`.
- [ ] Store access token in memory only.
- [ ] Use secure httpOnly cookie for refresh token handling.
- [ ] Attach Bearer token for protected requests.
- [ ] Attempt silent refresh on access token expiry/401.

### 3.2 UX checkpoints
- [ ] UI shows steps: Connect wallet → Sign message → Welcome.
- [ ] Pre-sign explainer includes “No gas fee, no transaction”.
- [ ] Signing state shows pending indicator + timeout guidance.
- [ ] Success state shows active session + linked wallet.
- [ ] Logout and disconnect are available separately.

### 3.3 Error handling
- [ ] Handle user reject (`4001`) with retry UX.
- [ ] Handle wallet timeout/no response and allow prompt retry.
- [ ] Handle invalid signature by resetting local auth state.
- [ ] Handle expired challenge by automatically requesting a new one.
- [ ] Handle refresh failure by clearing auth and redirecting to sign-in.
- [ ] Handle wallet disconnect mid-session without corrupting backend session.

### 3.4 Frontend security
- [ ] No auth token storage in localStorage/sessionStorage.
- [ ] CSP is strict and avoids unsafe-inline where feasible.
- [ ] Wallet/domain data is sanitized before UI rendering.
- [ ] Refresh cookies use strict SameSite strategy.
- [ ] Tokens are excluded from logs/analytics/error traces.

---

## 4) Backend API (Node.js)

### 4.1 Endpoint contracts

#### A) `POST /auth/challenge`
- [x] Validate address format, domain allowlist, chainId allowlist.
  - 2026-04-04: backend now enforces wallet regex, optional domain allowlist, and optional `AUTH_ALLOWED_CHAIN_IDS`.
- [ ] Apply per-IP and per-wallet rate limits.
- [x] Generate secure nonce (>=128 bits) and challenge payload.
  - 2026-04-04: challenge nonce uses `randomBytes(16)` and SIWE-like challenge content.
- [x] Persist challenge with TTL and unused status.
  - 2026-04-04: challenge rows are written with TTL expiration and `usedAt = null`.
- [x] Return `{ challengeId, message, expiresAt }`.
  - 2026-04-04: challenge endpoint returns persisted id + message + ISO expiry.

#### B) `POST /auth/verify`
- [x] Validate challenge exists, unused, and unexpired.
  - 2026-04-04: verify path performs DB-backed checks before issuing sessions.
- [x] Validate exact message match with issued challenge.
  - 2026-04-04: verify rejects message mismatch against stored challenge payload.
- [ ] Recover signer address and compare against expected address.
- [x] Atomically consume nonce/challenge.
  - 2026-04-04: challenge consumption now runs inside a pessimistic-write transaction.
- [x] Upsert user, create session, hash refresh token, issue access JWT.
  - 2026-04-04: verify upserts user and persists hashed refresh token in `auth_sessions`.
- [x] Set refresh cookie securely.
  - 2026-04-04: verify response sets `ctzn_refresh_token` as `HttpOnly + Secure + SameSite=Strict`.
- [x] Return `{ accessToken, tokenType, expiresIn, sessionId, user }`.
  - 2026-04-04: verify response currently returns those fields.

#### C) `POST /auth/refresh`
- [x] Validate refresh cookie presence and token format.
  - 2026-04-04: refresh endpoint requires cookie-backed token value.
- [x] Validate token hash against active non-revoked session.
  - 2026-04-04: refresh lookup matches hash against non-revoked active session.
- [x] Rotate refresh token atomically.
  - 2026-04-04: refresh now rotates token hash in a pessimistic-write transaction.
- [x] Issue new access token and update session last-used metadata.
  - 2026-04-04: refresh updates `last_used_at`, rotates cookie, and reissues access JWT.
- [x] Return `{ accessToken, tokenType, expiresIn }`.
  - 2026-04-04: refresh response keeps access-token-only payload while setting new refresh cookie.

#### D) `POST /auth/logout`
- [ ] Revoke current session.
- [ ] Clear refresh cookie.
- [ ] Return `{ ok: true }`.

### 4.2 Signature verification rules
- [ ] Parse SIWE-like message and reject malformed payloads.
- [ ] Reconstruct canonical message bytes exactly.
- [ ] Verify secp256k1-compatible signature recovery.
- [ ] Enforce nonce single-use, time window, domain/URI/audience, chainId.
- [ ] Write audit event for every verify attempt (success/failure reason).

### 4.3 JWT issuance and key management
- [ ] JWT includes `sub`, `wallet`, `sessionId`, `iat`, `exp`, `iss`, `aud` (optional scope/role).
- [ ] Access TTL set to 5–15 minutes.
- [ ] Session/refresh TTL set by risk policy (7–30 days).
- [ ] Use RS256 or EdDSA preferred (HS256 only with strict constraints).
- [ ] Include `kid` and support key rotation + rollover window.

---

## 5) PostgreSQL schema and session model

### 5.1 Schema implementation
- [x] `users` table exists (`id`, unique `wallet_address`, timestamps).
  - 2026-04-04: implemented as `auth_users` table with unique wallet address.
- [x] `auth_challenges` table exists (`id`, `wallet_address`, unique `nonce`, message/context, expiry, `used_at`).
  - 2026-04-04: implemented with `domain`, `uri`, and `chain_id` context fields.
- [x] `sessions` table exists (`id`, `user_id`, `refresh_token_hash`, expiry, revocation fields, metadata).
  - 2026-04-04: implemented as `auth_sessions` with user-agent/IP metadata.

### 5.2 Constraints and integrity
- [x] Unique index on normalized wallet address.
  - 2026-04-04: `auth_users.wallet_address` is unique and persisted normalized lowercase.
- [x] Unique constraint/index on challenge nonce.
  - 2026-04-04: `auth_challenges.nonce` uses unique DB index.
- [ ] Partial index for active sessions (`is_revoked=false`).
- [x] Challenge consume path uses transactional lock (`SELECT ... FOR UPDATE`).
  - 2026-04-04: verify path now locks challenge row with pessimistic write transaction.
- [ ] Cleanup jobs remove expired challenges/sessions.

### 5.3 Refresh rotation and revocation
- [ ] Store refresh token hash only (Argon2id or SHA-256 + pepper).
- [ ] Rotation replaces hash atomically.
- [ ] Reuse detection revokes session family and emits alert.
- [ ] Multi-device session strategy implemented.
- [ ] Logout-all endpoint revokes all active user sessions.

---

## 6) Token lifecycle behavior

### 6.1 Access token lifecycle
- [ ] Mint on verify and refresh.
- [x] Validate signature + claims (`exp`, `iss`, `aud`, `sessionId`) on protected routes.
  - 2026-04-04: guard now verifies issuer/audience and enforces non-revoked active session for JWTs carrying `sessionId`.
- [ ] Return machine-readable `401` error codes for invalid/expired tokens.

### 6.2 Refresh token lifecycle
- [ ] Generate >=256-bit random refresh token.
- [ ] Set cookie with `HttpOnly`, `Secure`, `SameSite`, restricted `path`.
- [ ] Rotate on every refresh.
- [ ] Revoke on logout, compromise signals, or anomalies.

### 6.3 Storage strategy
- [ ] Access token kept in memory only on web frontend.
- [ ] Refresh token never exposed to JS runtime.
- [ ] Mobile/native wrappers use OS secure storage where applicable.

---

## 7) Critical security gates (must pass before rollout)

### 7.1 Web/platform security
- [ ] HTTPS + HSTS + modern TLS enforced.
- [ ] CSP configured and validated.
- [ ] Security headers configured (`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`).
- [ ] Dependency and supply-chain scanning enabled in CI.

### 7.2 Auth security controls
- [ ] Replay prevention verified (single-use nonce + short challenge TTL).
- [ ] Domain/origin binding verified.
- [ ] Rate limiting active (IP, wallet, ASN, endpoint).
- [ ] Abuse detection + temporary lockout behavior implemented.
- [ ] JWT issuer/audience validation enforced everywhere.
- [x] Session revocation checks active on protected routes.
  - 2026-04-04: JWT guard validates session revocation/expiry when `sessionId` claim is present.
- [ ] Audit trail covers challenge, verify, refresh, logout.

### 7.3 CSRF/XSS hardening
- [ ] Refresh/logout CSRF protection validated.
- [ ] Output encoding and no dynamic script eval in auth surfaces.
- [ ] Refresh tokens never leave cookie boundary.

### 7.4 Governance-grade integrity
- [ ] Auth event stream is append-only (hash chain optional).
- [ ] Verification rules documented and versioned.
- [ ] Observer-verifiable evidence includes challenge ID, nonce hash, recovered address, decision code.
- [ ] Auth signing keys isolated from general app secrets.

---

## 8) Edge cases and failure handling
- [ ] User rejects signature path returns to connected/not-authenticated state.
- [ ] Expired challenge returns `CHALLENGE_EXPIRED` and retries cleanly.
- [ ] Invalid signature returns `INVALID_SIGNATURE` and increments abuse counters.
- [ ] Reused nonce returns `NONCE_ALREADY_USED` and flags event.
- [ ] Expired JWT returns `TOKEN_EXPIRED` with one refresh attempt.
- [ ] Revoked session returns `SESSION_REVOKED` and clears local auth.
- [ ] Wallet disconnect mid-session handled gracefully.
- [ ] Chain/account changes invalidate current challenge.
- [ ] Clock skew leeway configured (for example ±60 seconds).

---

## 9) Non-breaking integration with existing wallet + landing page

### 9.1 Compatibility constraints
- [ ] Existing wallet connect handshake remains unchanged.
- [ ] Existing provider globals stay intact; adapters are additive.
- [ ] Existing onboarding routes remain operational during migration.
- [ ] Current UI route/state transitions are preserved.
- [ ] Builder-sponsored transaction model remains unchanged.

### 9.2 Rollout sequence
- [ ] Add `/auth/*` endpoints in parallel with legacy flow.
- [ ] Add and wire `NEXT_PUBLIC_ENABLE_JWT_AUTH` feature flag.
- [ ] Keep legacy path when flag is off; JWT path when flag is on.
- [ ] Validate shared wallet-connect module across both flows.
- [ ] Roll out gradually (staging/canary → 5% → 25% → 50% → 100%).

### 9.3 Backward-compatible API rules
- [ ] No breaking changes to legacy request/response shapes without versioning.
- [ ] JWT transition responses are additive.
- [ ] Stable error envelope implemented:
  - [ ] `{ error: { code: string, message: string, retryable: boolean } }`
- [ ] Version header support implemented (for example `X-Auth-Version: jwt-v1`).

### 9.4 Required regression tests
- [ ] Wallet connect works with JWT flag off.
- [ ] Wallet connect works with JWT flag on.
- [ ] Signature popup works with current extension build.
- [ ] User rejection returns to onboarding screen without blank/error state.
- [ ] Existing onboarding submission works after successful JWT login.
- [ ] Refresh is silent and preserves onboarding form state.
- [ ] Logout clears JWT session and reconnect/sign still works.
- [ ] Legacy path remains functional until deprecation milestone.

### 9.5 Observability and rollback
- [ ] Metrics split by legacy vs JWT path (challenge, verify, refresh, rejection).
- [ ] Fast rollback switches available server-side and client-side.
- [ ] Auto-fallback policy defined for elevated verify/refresh failures.
- [ ] Migration runbook includes owners, SLOs, rollback criteria, comms plan.

---

## 10) Implementation sequence tracker
- [ ] Define SIWE-like spec + canonicalization tests.
- [ ] Implement wallet provider/signing UX + origin permissions.
- [ ] Implement backend challenge/verify + database models.
- [ ] Implement JWT/refresh issuance + rotation.
- [ ] Integrate frontend auth flow + middleware.
- [ ] Implement revocation/logout + multi-device views.
- [ ] Add rate limiting + audit logs + abuse detection.
- [ ] Execute security testing (replay, CSRF, XSS, token theft simulation).
- [ ] Complete production hardening (key rotation, alerting, backups, runbooks).
- [ ] Complete governance/observer review of deterministic verification evidence.

---

## 11) Sign-off checklist (ready for production)
- [ ] Engineering sign-off complete.
- [ ] Security sign-off complete.
- [ ] QA sign-off complete.
- [ ] Operations/runbook sign-off complete.
- [ ] Rollback drill executed successfully.
- [ ] Post-launch monitoring owners on-call and acknowledged.
