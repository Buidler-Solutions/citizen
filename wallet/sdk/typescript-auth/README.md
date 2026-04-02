# Citizen Wallet Auth TypeScript SDK

Browser-first SDK for integrating Citizen wallet login (`ctzn_requestAccounts` + backend challenge/verify).

## Features

- Provider detection: `window.citizen` fallback to `window.ctzn`
- Backend-first auth flow support:
  - `POST /auth/challenge`
  - `personal_sign` or `ctzn_signTypedData_v4`
  - `POST /auth/verify`
- Session lifecycle helpers:
  - `POST /auth/session/verify`
  - `POST /auth/session/revoke`
- Session token persistence helpers
- Minimal API intended for TypeScript apps (Next.js, React, Vite)

## Usage

```ts
import { createWalletAuthClient } from '@citizen/wallet-auth-typescript';

const client = createWalletAuthClient({
  authApiUrl: 'http://127.0.0.1:4499',
  onboardingPath: '/onboarding',
  network: 'futurenet',
  storageKey: 'citizen.wallet.auth.session',
});

const result = await client.loginWithBrowserWallet('personal_sign');
console.log(result.wallet, result.token);

const active = await client.verifyStoredSession();
console.log(active.session.sessionId);

await client.revokeStoredSession();
```

## API

- `createWalletAuthClient(options)`
- `WalletAuthClient#loginWithBrowserWallet()`
- `WalletAuthClient#loginWithBrowserWallet(signingMethod)`
- `WalletAuthClient#requestChallenge(wallet)`
- `WalletAuthClient#verifySignature(payload)`
- `WalletAuthClient#verifyStoredSession(token?)`
- `WalletAuthClient#revokeStoredSession(token?)`
- `WalletAuthClient#getStoredToken()`
- `WalletAuthClient#clearStoredToken()`

## Onboarding example

`landing-page/frontend/components/WalletOnboardingLogin.tsx` consumes this SDK as the reference integration.
