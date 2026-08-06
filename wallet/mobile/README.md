# Bahandi Mobile

Flutter-based mobile wallet for the Citizen Protocol. Client-facing wallet app for iOS and Android — signing, decryption, vault management, WalletConnect dApp integration, and secure platform key storage.

## Features

| Tab | Functionality |
|-----|---------------|
| **Activity** | Recent signing activity, network status, signer DID display |
| **Connect** | WalletConnect v2 dApp pairing — scan QR code or paste pairing URI, manage active sessions, approve/reject session proposals and signing requests |
| **Decrypt** | Hybrid decryption (X25519 ECDH + ChaCha20-Poly1305) of owned transaction ciphertext, reader/signer credential display |
| **Compose** | Sign & submit protocol payloads, sign arbitrary messages, direct submit to Citizen network |
| **Vault** | Multi-wallet management — generate/import mnemonic wallets (12/24 word choice), mandatory backup screen with acknowledgment, switch active wallet, tap-to-reveal mnemonic and private key |
| **Security** | Password setup/unlock/lock, network selection with liveness checks, direct submit destination config |
| **Profile** | User profile (name, email, address, profession, KYC status) |

### WalletConnect Integration

The mobile wallet acts as a WalletConnect v2 wallet (Web3Wallet), allowing dApps to pair and request signing operations:

- **Chain ID:** `citizen:mainnet` (namespace: `citizen`)
- **Methods:**

| Method | Description | Returns |
|--------|-------------|---------|
| `ctzn_signAuthChallenge` | Sign a dApp auth challenge | Base64URL signature |
| `ctzn_signCitizenTx` | Sign a protocol transaction payload | Hex signature |
| `ctzn_decryptTransaction` | Decrypt an owned transaction | Plaintext payload |
| `ctzn_getKeyMaterial` | Retrieve signer key material | Key material JSON |
| `ctzn_getEncryptionPublicKey` | Retrieve reader/encryption public key | X25519 public key hex |

- **Session approval** exposes both the signer DID (`did:key:ed25519:...`) and reader DID (`did:key:x25519:...`) as accounts.
- **Request flow:** dApp sends request → `WalletConnectService` routes to `onRequest` callback → `walletconnect_provider` sets `pendingRequest` → main screen listener shows `WCRequestDialog` → user approves/rejects → response sent via `respondSessionRequest`.

### Secure Key Storage

The wallet uses a split storage strategy to keep secrets safe:

| Storage | Contents | Platform Backing |
|---------|----------|-----------------|
| `flutter_secure_storage` | Private keys (`privateKeyHex`), mnemonic phrases | iOS Keychain / Android Keystore |
| `shared_preferences` | Non-sensitive metadata only (wallet ID, name, timestamps, derivation path, `hasMnemonic`, `mnemonicWordCount`) | Platform preferences |

The `StoredWallet` model enforces this separation with `toMetadataJson()` (safe, no secrets) for shared preferences and `toJson()` (full, secrets included) for secure storage only.

### Wallet Creation Flow

1. User selects **12 or 24 word** mnemonic length
2. Mnemonic is generated via BIP39 word list
3. **Mandatory backup screen** displays the mnemonic with tap-to-reveal
4. User must check an acknowledgment checkbox confirming they've saved the backup
5. Wallet is created and keys are derived via SLIP-0010 hardened derivation
6. Secrets are stored in secure storage; metadata in shared preferences

## Crypto Layer

Replicates the browser extension's exact derivation path:
- **BIP39** mnemonic → 64-byte seed via PBKDF2-HMAC-SHA512 (2048 iterations, salt: `"mnemonic"`)
- **SLIP-0010** hardened derivation: `m/44'/930'/0'/0'/0'`
- **Ed25519** for protocol signing (`did:key:ed25519:<hex>`)
- **X25519** for encryption reader key (`did:key:x25519:<hex>`)
- **ChaCha20-Poly1305** for hybrid transaction decryption
- **AES-256-GCM** with PBKDF2 (210K iterations) for backup vault encryption

## Architecture

```
lib/
  core/
    config/app_config.dart           # Storage keys, allowlists, constants
    theme/app_theme.dart             # Material 3 dark theme
    utils/
      hex_utils.dart                 # Hex/Base64/Base64URL conversions
      canonical_json.dart            # Canonical JSON for protocol hashing
  data/
    models/                          # Data models (wallet, network, receipts, etc.)
    services/
      crypto_service.dart            # Ed25519/X25519/ChaCha20/AES-GCM crypto
      mnemonic_service.dart          # BIP39 mnemonic generation/validation
      storage_service.dart           # Secure storage + shared preferences
      citizen_api_service.dart       # Dio HTTP client, health checks, direct submit
      walletconnect_service.dart     # WalletConnect v2 Web3Wallet, session/request routing
  providers/                         # Riverpod state management
    wallet_provider.dart             # Wallet state, generate/import/delete/setActive
    walletconnect_provider.dart      # WC session/request state, proposal/request approval
  presentation/
    screens/                         # 7 main screens + lock screen
      connect_screen.dart            # WalletConnect pairing (QR scanner + paste URI + sessions)
    widgets/
      wc_request_dialog.dart         # Session proposal + request approval dialogs
  router/app_router.dart             # GoRouter with lock-aware redirect
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `flutter_riverpod` ^2.6.1 | State management |
| `go_router` ^14.8.1 | Declarative navigation with redirect guards |
| `dio` ^5.7.0 | HTTP client for Citizen API |
| `cryptography` ^2.7.0 | Ed25519, X25519, ChaCha20-Poly1305, AES-GCM, PBKDF2, HMAC |
| `walletconnect_flutter_v2` ^2.3.0 | WalletConnect v2 Web3Wallet SDK |
| `mobile_scanner` ^5.2.3 | QR code camera scanner for WalletConnect pairing |
| `flutter_secure_storage` ^9.2.2 | iOS Keychain / Android Keystore for secrets |
| `shared_preferences` ^2.3.2 | Non-sensitive metadata storage |
| `google_fonts` ^6.2.1 | Material 3 typography |

## Build

```bash
cd wallet/mobile
flutter pub get
flutter run                    # debug on connected device/emulator
flutter build apk             # release APK
flutter build ios             # release iOS
```

## Network Support

| Network | Chain ID | Status |
|---------|----------|--------|
| Mainnet | `0xc17` | Configured |
| Futurenet | `0xc18` | Configured |
| Testnet | `0xc19` | Configured |
| Local Node | `0x539` | Configured |

Direct submit destinations are enforce-allowlisted to Citizen network endpoints only.
