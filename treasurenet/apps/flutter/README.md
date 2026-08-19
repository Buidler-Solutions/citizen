# TreasureNet Mobile App — Flutter Port Plan

Port of the original TreasureNet Flutter player client onto Citizen Protocol.
The implementation reuses patterns from the monorepo's existing Flutter
wallet (`wallet/mobile`), which already ships the required primitives.

## What carries over unchanged

- GPS tracking with 1-meter precision and map UI (geolocator + flutter_map)
- Clue flow UI and hunt list screens
- Anti-spoof sensor checks (mock-location detection, accelerometer sanity)
- Secure platform key storage (iOS Keychain / Android Keystore via
  flutter_secure_storage, matching `wallet/mobile`)
- BIP39-free key model: a single Ed25519 device keypair (Citizen DIDs do not
  use mnemonics; see MIGRATION_NOTES)

## What changes versus the Stellar original

| Original (Stellar) | Citizen port |
|---|---|
| Stellar keypair (G.../S...) generated on device | Ed25519 keypair generated on device, DID = `did:key:ed25519:<pubhex>` |
| Secure enclave stores Stellar seed | Secure storage stores the raw Ed25519 private key (32 bytes) |
| Sep10-style challenge auth | `POST /auth/challenge` then sign `treasurenet-login:<nonce>` with Ed25519 |
| Freighter / built-in wallet sends XLM transactions | Backend-sponsored chain writes via builder credits; app only signs messages |
| Claim screen shows Stellar tx hash | Claim screen shows Citizen finality: receipt id + block height + hash from `/games/:id` and `/wallet/:did/receipts` |
| Clue payloads fetched from backend DB | Encrypted file store manifests; on-device decryption after `citizen_read_file` authorization |

## Screens

1. **Onboarding** — generate device keypair, show DID, register wallet
2. **Login** — challenge-response with biometric unlock of the secure key
3. **Hunt list / hunt detail** — active hunts, distance, reward, expiry
4. **Clue flow** — GPS check-ins, unlocked clue manifests, decrypted text
5. **Claim** — photo proof capture, oracle verdict progress, finality receipt
6. **Wallet** — CTZN balance, payout receipts (block height + proof)
7. **Consent** — location/photo consent receipt status and re-grant

## Implementation order

1. Scaffold app reusing `wallet/mobile` project structure (Riverpod +
   GoRouter + secure storage already proven there)
2. Port crypto: replace Stellar SDK signing with `cryptography` Ed25519
   (identical raw 32-byte key format to the browser console and backend)
3. Port auth + wallet registration against the 7755 API
4. Port hunt list + clue flow (geolocator, check-in endpoint)
5. Port claim flow with photo capture + finality receipt screen
6. Add anti-spoof sensor checks and consent receipt screen

## Shared crypto parity requirement

All surfaces derive identical signatures over identical message strings
(see `chain/sdk/src/modules.ts` `claimMessages`). The mobile port must sign:

- login: `treasurenet-login:<nonce>`
- nothing else client-side: player actions are service-sponsored

Game Masters use the browser console, which signs hunt lifecycle messages
with WebCrypto Ed25519 over the same canonical strings.
