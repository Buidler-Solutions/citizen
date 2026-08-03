# Networks

Citizen supports multiple network configurations for different use cases.

## Available Networks

| Network | Chain ID | Use Case |
|---------|----------|----------|
| **Mainnet** | `0xc17` | Production network |
| **Futurenet** | `0xc18` | Pre-release testing |
| **Testnet** | `0xc19` | Public testing |
| **Local Node** | `0x539` | Local development |

## Local Node

The local node is the default for development. It runs entirely on your machine using pre-configured validator sets.

```bash
cd citizen-protocol
./target/release/citizen-node --config config/localnet/validator-alpha.toml
```

The localnet configuration includes 5 validators (alpha through epsilon) with predefined ports and identities.

## Connecting a Wallet

All wallet surfaces support network selection:

=== "Mobile"
    Settings → Network → Select network

=== "Browser Extension"
    Settings → Network → Select network

=== "CLI"
    ```bash
    citizen-wallet-cli --network testnet
    ```

=== "SDK"
    ```typescript
    const client = new CitizenClient({
      network: 'testnet',
    });
    ```

## Direct Submit

Wallets can submit signed entries directly to Citizen network endpoints. Submit destinations are enforce-allowlisted to prevent accidental submission to non-Citizen services.

## Liveness Checks

All wallet surfaces perform periodic liveness checks against the configured network endpoint to verify connectivity and node health.
