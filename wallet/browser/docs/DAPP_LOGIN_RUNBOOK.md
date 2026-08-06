# Bahandi Browser Extension Runbook: dApp Login

For cross-component developer documentation (backend, API, extension, operations), see:

- `wallet/docs/WALLET_DAPP_AUTH_DEVELOPER_GUIDE.md`

## Goal

Implement dApp login for Citizen blockchain in a Citizen-native wallet operating model:

1. Request account access.
2. Ask backend for nonce/challenge.
3. Sign with wallet (`personal_sign` or `ctzn_signTypedData_v4`).
4. Verify server-side.
5. Issue backend-owned session.

This keeps wallet signatures as identity proof and backend sessions as access control.

---

## Supported Provider Methods (Login-Relevant)

- `ctzn_requestAccounts`
- `ctzn_accounts`
- `ctzn_chainId`
- `personal_sign`
- `ctzn_signTypedData_v4`
- `wallet_switchCtznChain`
- `ctzn_getCitizenSigner` (Ed25519 DID/profile for protocol transaction signing)
- `ctzn_signCitizenTx` (canonical JSON signing for Citizen protocol transactions)

Citizen-namespace aliases (`citizen_requestAccounts`, `citizen_accounts`, `citizen_chainId`) are also available for compatibility.

## Citizen Protocol Runtime Signing Model

The wallet extension now treats Citizen protocol transaction signing separately from login signatures:

- Login/auth: `personal_sign` / `ctzn_signTypedData_v4` for backend challenge verification.
- Protocol signing: `ctzn_signCitizenTx` signs canonical JSON payloads with a dedicated Ed25519 keypair.

`ctzn_signCitizenTx` mirrors the protocol wallet crate's canonical JSON strategy (sorted object keys, undefined object fields omitted) so dApps can submit stable signing payloads to Citizen node/API services. The signing result also includes `payloadHash` in runtime commitment format (`sha256:<hex>`) for direct anchoring/receipt workflows.

Concurrency policy for `ctzn_signCitizenTx` requests is currently **single-active**: only one pending signing request may exist at a time. If another dApp request arrives before the pending request is approved/rejected/expired, the wallet returns deterministic error code `ERR_CONCURRENT_REQUEST`.

---

## Recommended Login Architecture

### Frontend

1. Detect provider: `window.citizen ?? window.ctzn`.
2. Connect wallet with `ctzn_requestAccounts`.
3. Call backend `POST /auth/challenge` to fetch nonce + message template.
4. Sign backend message with:
   - `personal_sign` for text-based challenges, or
   - `ctzn_signTypedData_v4` for EIP-712 typed payloads.
5. Submit signature to backend `POST /auth/verify`.
6. Store only backend session token/cookie.

### Backend

1. Generate cryptographically random nonce.
2. Persist nonce with TTL and one-time-use flag.
3. Verify signature recovers the claimed wallet address.
4. Validate nonce, domain, origin, chain, and timestamp constraints.
5. Mark nonce consumed.
6. Issue short-lived session (JWT/cookie).

---

## Login Flow A: `personal_sign` (Citizen-Common)

```ts
const provider = window.citizen ?? window.ctzn;
const [account] = await provider.request({ method: "ctzn_requestAccounts" });

const challenge = await fetch("/auth/challenge", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ account })
}).then((r) => r.json());

const signature = await provider.request({
  method: "personal_sign",
  params: [challenge.message, account]
});

await fetch("/auth/verify", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ account, message: challenge.message, signature, nonce: challenge.nonce })
});
```

---

## Login Flow B: `ctzn_signTypedData_v4` (EIP-712)

```ts
const provider = window.citizen ?? window.ctzn;
const [account] = await provider.request({ method: "ctzn_requestAccounts" });

const typed = await fetch("/auth/typed-challenge", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ account })
}).then((r) => r.json());

const signature = await provider.request({
  method: "ctzn_signTypedData_v4",
  params: [account, JSON.stringify(typed)]
});

await fetch("/auth/verify-typed", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ account, typedData: typed, signature })
});
```

---

## Chain Management (Bahandi)

Use `wallet_switchCtznChain` with configured Citizen chain IDs:

- Mainnet: `0xc17`
- Futurenet: `0xc18`
- Testnet: `0xc19`
- Local Node: `0x539`

Example:

```ts
await provider.request({
  method: "wallet_switchCtznChain",
  params: [{ chainId: "0xc18" }]
});
```

---

## Security Checklist

- Server-generated nonce only.
- Nonce one-time use + strict TTL.
- Domain/origin binding in message and backend checks.
- Clock skew tolerance for timestamp checks.
- HTTPS-only in production.
- Rate limiting per IP + wallet address.
- Session rotation and explicit logout/revocation.

---

## Troubleshooting

### `Unsupported method: wallet_switchCtznChain`
- Ensure wallet extension is on an updated build.

### `Requested account does not match active wallet account`
- dApp passed an account different from current selected wallet address.

### Signature verifies locally but backend rejects
- Check message canonicalization (line breaks/whitespace), nonce reuse, timestamp, and expected domain/origin.

### `ctzn_signTypedData_v4` invalid payload
- Ensure the payload has `domain`, `types`, `message` and is valid JSON when stringified.

---

## Verification Commands

From wallet browser workspace:

```bash
npm run test
npm run lint
npm run build
```

From dApp web workspace:

```bash
cd dapp/apps/web
npm run dev
```
