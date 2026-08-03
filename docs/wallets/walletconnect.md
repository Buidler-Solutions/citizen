# WalletConnect Integration

The Citizen mobile wallet supports **WalletConnect v2** for dApp pairing, allowing web applications to request signing and decryption operations from the user's mobile wallet.

## Overview

```
┌─────────┐     WalletConnect v2     ┌──────────────┐
│  dApp   │ ◄──────────────────────► │ Mobile Wallet │
│ (Web)   │   QR code / pairing URI  │  (Flutter)   │
└─────────┘                          └──────────────┘
                                          │
                                    ┌─────┴──────┐
                                    │ User approves│
                                    │ or rejects   │
                                    └─────────────┘
```

## For dApp Developers

### Initialize the Connection

From your web dApp, generate a WalletConnect pairing URI using the WalletConnect v2 SDK:

```typescript
import SignClient from '@walletconnect/sign-client';

const signClient = await SignClient.init({
  projectId: '<your-walletconnect-project-id>',
});

const { uri } = await signClient.connect({
  requiredNamespaces: {
    citizen: {
      chains: ['citizen:mainnet'],
      methods: [
        'ctzn_signAuthChallenge',
        'ctzn_signCitizenTx',
        'ctzn_decryptTransaction',
        'ctzn_getKeyMaterial',
        'ctzn_getEncryptionPublicKey',
      ],
      events: [],
    },
  },
});

// Display `uri` as a QR code for the user to scan
```

### Supported Methods

| Method | Parameters | Returns | Use Case |
|--------|-----------|---------|----------|
| `ctzn_signAuthChallenge` | `{ challenge: string }` | `{ signature: base64url }` | dApp login |
| `ctzn_signCitizenTx` | `{ payload: object }` | `{ signature: hex }` | Transaction signing |
| `ctzn_decryptTransaction` | `{ ciphertext: string }` | `{ plaintext: string }` | Data decryption |
| `ctzn_getKeyMaterial` | `{}` | `{ signerDid, publicKey }` | Key retrieval |
| `ctzn_getEncryptionPublicKey` | `{}` | `{ publicKey: hex }` | Encryption key |

### Session Accounts

After pairing, the session exposes two accounts:

- **Signer DID**: `did:key:ed25519:<hex>` - for transaction signing
- **Reader DID**: `did:key:x25519:<hex>` - for data decryption

### Send a Request

```typescript
const result = await signClient.request({
  topic: session.topic,
  chainId: 'citizen:mainnet',
  request: {
    method: 'ctzn_signAuthChallenge',
    params: { challenge: 'login-challenge-12345' },
  },
});

console.log(result.signature); // base64url signature
```

## For Wallet Users

### Pairing with a dApp

1. Open the **Connect** tab in the mobile wallet
2. The dApp will display a QR code or pairing URI
3. Tap **Scan QR** and point your camera at the code, or tap **Paste URI** to paste manually
4. Review the session proposal - it shows the dApp name and requested methods
5. Tap **Approve** to connect

### Responding to Requests

When a dApp sends a request:

1. A dialog appears showing the request details
2. Review the method and parameters
3. Tap **Approve** or **Reject**
4. The response is sent back to the dApp automatically

### Managing Sessions

The Connect tab shows all active sessions. You can disconnect from a dApp at any time by tapping **Disconnect** on the session card.
