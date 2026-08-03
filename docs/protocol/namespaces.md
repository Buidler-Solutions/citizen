# Namespaces

Namespaces are the fundamental unit of organization in Citizen. Each namespace operates as an independent governed domain with its own policies, rules, and entry types.

## What is a Namespace?

A namespace is a scoped partition of the ledger where:

- Entries are validated against namespace-specific policies
- Signers must be authorized by the namespace
- Data custody and privacy rules are enforced per-namespace
- Governance proposals can modify namespace behavior

## Namespace Policies

Each namespace can configure the following policies:

| Policy | Purpose |
|--------|---------|
| **Signature policy** | Which signature schemes and key types are accepted |
| **Consent policy** | Whether consent receipts are required for entries |
| **Builder-credit policy** | Rules for fee credits and sponsored usage |
| **Privacy policy** | Field-level encryption and selective disclosure |
| **Asset-control policy** | Asset issuance, transfer, and clawback rules |
| **WASM runtime policy** | Whether scoped execution is enabled and its limits |
| **Interop adapter policy** | Rules for cross-system bridges |
| **Off-chain encrypted file policy** | Allowed MIME types, size limits for encrypted attachments |

## Creating a Namespace

New namespaces are created through governance proposals:

```bash
citizen-wallet-cli propose-namespace \
  --name "civic-records" \
  --signature-policy ed25519 \
  --consent-policy required \
  --builder-credit-policy standard
```

The proposal goes through the standard governance lifecycle (proposal → voting → activation).

## Namespace Readiness

Before activation, the governance engine validates that a namespace has:

- A valid signature scheme
- All required policies configured
- No conflicts with existing namespaces
- Proper admission criteria

## Default Namespace

The protocol includes a `default` namespace that is always available. It uses standard policies and is suitable for testing and initial onboarding.
