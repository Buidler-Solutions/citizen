# Mobile Wallet

Bahandi is the Citizen Protocol's Flutter-based mobile wallet for iOS and Android, providing native wallet UX with WalletConnect dApp integration.

## Installation

### Prerequisites

- Flutter SDK 3.12+
- Xcode (iOS) or Android Studio (Android)

### Build

```bash
cd wallet/mobile
flutter pub get
flutter run                    # Debug on connected device/emulator
flutter build apk             # Release APK (Android)
flutter build ios             # Release iOS
```

## Interface (7 Tabs)

| Tab | Functionality |
|-----|---------------|
| **Activity** | Recent signing activity, network status, signer DID display |
| **Connect** | WalletConnect v2 dApp pairing - scan QR or paste URI, manage sessions |
| **Decrypt** | Hybrid decryption (X25519 ECDH + ChaCha20-Poly1305), credential display |
| **Compose** | Sign & submit protocol payloads, sign arbitrary messages, direct submit |
| **Vault** | Multi-wallet management - 12/24 word choice, mandatory backup, key reveal |
| **Security** | Password setup/unlock/lock, network selection, liveness checks |
| **Profile** | User profile (name, email, address, profession, KYC status) |

## Wallet Creation Flow

1. Select **12 or 24 word** mnemonic length
2. Mnemonic is generated via BIP39
3. **Mandatory backup screen** displays the mnemonic (tap-to-reveal)
4. Acknowledge that you've saved the backup
5. Keys are derived via SLIP-0010 hardened derivation
6. Secrets stored in secure storage; metadata in shared preferences

## Secure Key Storage

| Storage | Contents | Platform Backing |
|---------|----------|-----------------|
| `flutter_secure_storage` | Private keys, mnemonic phrases | iOS Keychain / Android Keystore |
| `shared_preferences` | Non-sensitive metadata (ID, name, timestamps) | Platform preferences |

Private keys and mnemonics **never** touch shared preferences or plaintext storage.

## WalletConnect Integration

The mobile wallet acts as a WalletConnect v2 wallet, allowing dApps to pair and request operations.

### Methods

| Method | Description | Returns |
|--------|-------------|---------|
| `ctzn_signAuthChallenge` | Sign a dApp auth challenge | Base64URL signature |
| `ctzn_signCitizenTx` | Sign a protocol transaction | Hex signature |
| `ctzn_decryptTransaction` | Decrypt an owned transaction | Plaintext payload |
| `ctzn_getKeyMaterial` | Retrieve signer key material | Key material JSON |
| `ctzn_getEncryptionPublicKey` | Retrieve reader/encryption public key | X25519 public key hex |

### Pairing Flow

1. Open the **Connect** tab
2. Scan the dApp's QR code or paste the pairing URI
3. Review the session proposal (shows requesting dApp and requested methods)
4. Approve or reject the session
5. When the dApp sends a request, a dialog appears for approval
6. Review the request payload, then approve or reject

### Session Accounts

Session approval exposes both:
- **Signer DID**: `did:key:ed25519:<hex>`
- **Reader DID**: `did:key:x25519:<hex>`

## Dependencies

| Package | Purpose |
|---------|---------|
| `flutter_riverpod` | State management |
| `go_router` | Navigation with lock-aware redirects |
| `dio` | HTTP client for Citizen API |
| `cryptography` | Ed25519, X25519, ChaCha20-Poly1305, AES-GCM |
| `walletconnect_flutter_v2` | WalletConnect v2 Web3Wallet SDK |
| `mobile_scanner` | QR code camera scanner |
| `flutter_secure_storage` | Platform keychain/keystore |
| `google_fonts` | Material 3 typography |
