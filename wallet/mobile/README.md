# Citizen Wallet Mobile

Flutter-based mobile wallet for the Citizen Protocol. Client-facing wallet app replicating the browser extension functionality with native mobile UX.

## Features

| Tab | Functionality |
|-----|--------------|
| **Activity** | Recent signing activity, network status, signer DID display |
| **Decrypt** | Hybrid decryption (X25519 ECDH + ChaCha20-Poly1305) of owned transaction ciphertext |
| **Compose** | Sign & submit protocol payloads, sign arbitrary messages, direct submit to Citizen network |
| **Vault** | Multi-wallet management — generate/import mnemonic wallets (12/24 word), switch active wallet, reveal mnemonic |
| **Security** | Password setup/unlock/lock, network selection with liveness checks, direct submit destination config |
| **Profile** | User profile (name, email, address, profession, KYC status) |

## Crypto Layer

Replicates the browser extension's exact derivation path:
- **BIP39** mnemonic → seed via PBKDF2-HMAC-SHA512 (2048 iterations)
- **SLIP-0010** hardened derivation: `m/44'/930'/0'/0'/0'`
- **Ed25519** for protocol signing (`did:key:ed25519:<hex>`)
- **X25519** for encryption reader key (`did:key:x25519:<hex>`)
- **ChaCha20-Poly1305** for hybrid transaction decryption
- **AES-256-GCM** with PBKDF2 (210K iterations) for backup vault encryption

## Architecture

```
lib/
  core/
    config/app_config.dart       # Storage keys, allowlists, constants
    theme/app_theme.dart         # Material 3 dark theme
    utils/
      hex_utils.dart             # Hex/Base64/Base64URL conversions
      canonical_json.dart        # Canonical JSON for protocol hashing
  data/
    models/                      # Data models (wallet, network, receipts, etc.)
    services/
      crypto_service.dart        # Ed25519/X25519/ChaCha20/AES-GCM crypto
      mnemonic_service.dart      # BIP39 mnemonic generation/validation
      storage_service.dart       # Secure storage + shared preferences
      citizen_api_service.dart   # Dio HTTP client, health checks, direct submit
  providers/                     # Riverpod state management
  presentation/
    screens/                     # 6 main screens + lock screen
  router/app_router.dart         # GoRouter with lock-aware redirect
```

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
