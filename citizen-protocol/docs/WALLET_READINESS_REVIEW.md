# Wallet System Readiness Review

Date: 2026-02-11

## Executive Decision

**Yes — we can start implementing both the dedicated CLI app and the React wallet now.**

The current repository already has a functional Rust wallet core (`crates/wallet`) with encrypted key custody, entry signing, and signature verification, plus a standalone CLI binary wrapper (`wallet/cli`).

That gives us enough foundation to begin application-layer work immediately, while closing a short list of integration gaps in parallel.

---

## Current Baseline (What Exists)

### 1) Reusable wallet core is present
- Ed25519 key generation and restore from raw secret bytes.
- Deterministic entry signing with canonical JSON normalization.
- Signature verification.
- Encrypted secret key storage primitives (Argon2id + ChaCha20-Poly1305).

### 2) CLI command surface is already usable
Current commands in the shared CLI implementation:
- `init`
- `keygen`
- `import-key`
- `public-key`
- `list-keys`
- `sign-entry`
- `verify-entry`

### 3) Dedicated app folders exist
- `wallet/cli/` is wired as a runnable binary package using the shared CLI implementation.
- `wallet/react/` exists as a placeholder, ready for scaffolding.

---

## Readiness Verdict by Track

## CLI Wallet Track

**Readiness: High (start now).**

You can proceed with immediate implementation of:
1. API submission command(s) and receipt persistence.
2. Namespace-focused authoring helpers.
3. Better UX hardening (password prompts, output modes, structured errors).

Blocking risks are low because key lifecycle and signing are already in place.

## React Wallet Track

**Readiness: Medium (start now, in parallel with API contract work).**

You can proceed with immediate implementation of:
1. App scaffold + design system + route skeletons.
2. Local key onboarding experience and secure browser storage strategy.
3. Entry builder UI shells per namespace.

Main dependency: lock a stable wallet-facing API contract (submit/status/governance endpoints) so frontend integration does not churn.

---

## Critical Gaps to Close First (Week 1)

1. **Node API contract freeze (versioned).**
   - Request/response schemas for entry submission and status polling.
2. **Receipt model finalization.**
   - Standard shape for `entry_id`, inclusion/finality status, block height, and proof payloads.
3. **CLI keystore format decision.**
   - Confirm JSON vs SQLite for near-term roadmap; document migration path if starting with JSON.
4. **React key strategy decision.**
   - Browser-only crypto vs local companion/bridge for stronger key custody.

---

## Recommended Next Sprint Plan

1. **CLI Sprint A**
   - Add `submit` command + HTTP client abstraction.
   - Add receipt persistence and `receipt get/list` commands.
   - Add integration tests against localnet.

2. **React Sprint A**
   - Scaffold app (choose Next.js or Vite explicitly).
   - Build onboarding flow (create/import key, passphrase).
   - Build entry draft form and local signing preview.

3. **Shared Workstream**
   - Publish `wallet-api` schema package (or versioned OpenAPI).
   - Add end-to-end flow doc covering CLI + React parity.

---

## Go / No-Go Summary

- **CLI implementation start:** **GO**
- **React wallet implementation start:** **GO**
- **Condition:** keep API/schema alignment as a first-class parallel task.
