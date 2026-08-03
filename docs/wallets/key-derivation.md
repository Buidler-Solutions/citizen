# Key Derivation

All Citizen wallet surfaces share the same cryptographic derivation chain to ensure cross-platform key compatibility.

## Derivation Chain

```
BIP39 Mnemonic
      │
      ▼
PBKDF2-HMAC-SHA512 (2048 iterations, salt: "mnemonic")
      │
      ▼ 64-byte seed
      │
SLIP-0010 Hardened Derivation: m/44'/930'/0'/0'/0'
      │
      ├──────────────────┬──────────────────┐
      ▼                  ▼                  
Ed25519 Signer      X25519 Reader          
(did:key:ed25519:)  (did:key:x25519:)      
Transaction signing Data decryption        
```

## BIP39 Mnemonic

- Word list: English BIP39 (2048 words)
- Options: 12 words (128 bits entropy) or 24 words (256 bits entropy)
- Seed generation: PBKDF2-HMAC-SHA512 with 2048 iterations
- Salt: `"mnemonic"` (empty passphrase, per BIP39 spec)
- Seed length: 64 bytes (512 bits)

!!! warning "Common Pitfall"
    The salt must be exactly the string `"mnemonic"` — not `"mnemonic" + words` or any variation. An incorrect salt produces incompatible keys.

## SLIP-0010 Derivation

Citizen uses SLIP-0010 for Ed25519-compatible hierarchical derivation:

- **Purpose**: `44'` (BIP44 standard)
- **Coin type**: `930'` (Citizen registered coin type)
- **Account**: `0'`
- **Change**: `0'`
- **Address index**: `0'`

```
m / 44' / 930' / 0' / 0' / 0'
```

All components use hardened derivation (indicated by `'`), which is required for Ed25519 under SLIP-0010.

## Key Pairs

### Ed25519 Signer

- **Purpose**: Transaction signing, authentication challenges
- **DID format**: `did:key:ed25519:<multibase-encoded-public-key>`
- **Signature format**: 64-byte Ed25519 signature
- **WalletConnect return**: Base64URL (auth challenge) or Hex (transaction)

### X25519 Reader

- **Purpose**: Data decryption via X25519 ECDH key exchange
- **DID format**: `did:key:x25519:<multibase-encoded-public-key>`
- **Derived from**: Same 32-byte secret as the Ed25519 signer

## Cross-Platform Compatibility

Because all surfaces use the exact same derivation parameters:

| Action | Result |
|--------|--------|
| Generate on mobile, import on browser extension | Same keys ✅ |
| Generate on CLI, import on desktop | Same keys ✅ |
| Generate on browser, import on mobile | Same keys ✅ |

!!! tip
    You only need one mnemonic. Import it on whichever surface you prefer — the derived keys will always match.

## Encryption Algorithms

| Algorithm | Use Case |
|-----------|----------|
| **ChaCha20-Poly1305** | Hybrid transaction decryption (via X25519 ECDH) |
| **AES-256-GCM** | Backup vault encryption (with PBKDF2 210K iterations) |
| **PBKDF2-HMAC-SHA512** | Mnemonic → seed, backup password → key |
