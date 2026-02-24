# On-Chain Policy Runtime Sync Sample (All Validator Nodes)

## Goal

Provide a complete sample showing how to keep governance-approved namespace policy
consistent across every validator runtime config.

> Important: every validator must run the **same governed namespace policy** for
> deterministic validation. Divergent policy configs can cause block rejection
> and liveness loss.

## 1) Canonical policy package (source-of-truth)

Use the following `namespaces` package as the canonical policy payload to
propagate to all validator runtimes.

```toml
[[namespaces]]
descriptor.namespace = "builder.credits"
descriptor.version = 1
descriptor.rules_hash = "sha256:builder-credits-v1"
descriptor.governed_by = "governance.vote"
writers = ["builder.credits"]

[[namespaces.validators]]
name = "require_signature"
config = {}

[[namespaces.validators]]
name = "builder_credit_policy"
config.required_grant_approvals = 3
config.max_daily_spend = 5000
config.grant_approvers = [
  { id = "grant:ops-1", public_key = "11eec230e93451631d92331ab14f7cd3beb71d7d0664213c3c245ee34e218bbc" },
  { id = "grant:ops-2", public_key = "4fba12886de6f3955e1e00122ecfa5f28f6143b4ebfd623426b31db6e3ba759b" },
  { id = "grant:ops-3", public_key = "05d820297454180f0a29826db77629efaf2866ce6321bdf1e36653fbce5f87fc" },
  { id = "grant:ops-4", public_key = "871aae4a90265130ec08636783f7c6967201557511093f2ebe5b1ec3b5759500" },
  { id = "grant:ops-5", public_key = "64b4461734432d8b1651171a2f4385948748665c876a377cd1722ef55389553b" }
]

[namespaces.validators.config.programmable_multisig]
enabled = false
policy_id = "builder-credits-auto-v1"
actors = ["automation.builder-credit-bot"]
max_grant_amount = 1000
```

## 2) Apply to every validator runtime config

The namespace policy block above must be byte-identical in each validator node
runtime config (`node.toml`).

### validator-alpha (sample)

```toml
node_role = "validator"
validator_id = "validator-alpha"
network_id = "citizen-localnet"

[[namespaces]]
descriptor.namespace = "builder.credits"
descriptor.version = 1
descriptor.rules_hash = "sha256:builder-credits-v1"
descriptor.governed_by = "governance.vote"
writers = ["builder.credits"]

[[namespaces.validators]]
name = "require_signature"
config = {}

[[namespaces.validators]]
name = "builder_credit_policy"
config.required_grant_approvals = 3
config.max_daily_spend = 5000
config.grant_approvers = [
  { id = "grant:ops-1", public_key = "11eec230e93451631d92331ab14f7cd3beb71d7d0664213c3c245ee34e218bbc" },
  { id = "grant:ops-2", public_key = "4fba12886de6f3955e1e00122ecfa5f28f6143b4ebfd623426b31db6e3ba759b" },
  { id = "grant:ops-3", public_key = "05d820297454180f0a29826db77629efaf2866ce6321bdf1e36653fbce5f87fc" },
  { id = "grant:ops-4", public_key = "871aae4a90265130ec08636783f7c6967201557511093f2ebe5b1ec3b5759500" },
  { id = "grant:ops-5", public_key = "64b4461734432d8b1651171a2f4385948748665c876a377cd1722ef55389553b" }
]

[namespaces.validators.config.programmable_multisig]
enabled = false
policy_id = "builder-credits-auto-v1"
actors = ["automation.builder-credit-bot"]
max_grant_amount = 1000
```

### validator-beta (sample)

```toml
node_role = "validator"
validator_id = "validator-beta"
network_id = "citizen-localnet"

[[namespaces]]
descriptor.namespace = "builder.credits"
descriptor.version = 1
descriptor.rules_hash = "sha256:builder-credits-v1"
descriptor.governed_by = "governance.vote"
writers = ["builder.credits"]

[[namespaces.validators]]
name = "require_signature"
config = {}

[[namespaces.validators]]
name = "builder_credit_policy"
config.required_grant_approvals = 3
config.max_daily_spend = 5000
config.grant_approvers = [
  { id = "grant:ops-1", public_key = "11eec230e93451631d92331ab14f7cd3beb71d7d0664213c3c245ee34e218bbc" },
  { id = "grant:ops-2", public_key = "4fba12886de6f3955e1e00122ecfa5f28f6143b4ebfd623426b31db6e3ba759b" },
  { id = "grant:ops-3", public_key = "05d820297454180f0a29826db77629efaf2866ce6321bdf1e36653fbce5f87fc" },
  { id = "grant:ops-4", public_key = "871aae4a90265130ec08636783f7c6967201557511093f2ebe5b1ec3b5759500" },
  { id = "grant:ops-5", public_key = "64b4461734432d8b1651171a2f4385948748665c876a377cd1722ef55389553b" }
]

[namespaces.validators.config.programmable_multisig]
enabled = false
policy_id = "builder-credits-auto-v1"
actors = ["automation.builder-credit-bot"]
max_grant_amount = 1000
```

### validator-gamma (sample)

```toml
node_role = "validator"
validator_id = "validator-gamma"
network_id = "citizen-localnet"

[[namespaces]]
descriptor.namespace = "builder.credits"
descriptor.version = 1
descriptor.rules_hash = "sha256:builder-credits-v1"
descriptor.governed_by = "governance.vote"
writers = ["builder.credits"]

[[namespaces.validators]]
name = "require_signature"
config = {}

[[namespaces.validators]]
name = "builder_credit_policy"
config.required_grant_approvals = 3
config.max_daily_spend = 5000
config.grant_approvers = [
  { id = "grant:ops-1", public_key = "11eec230e93451631d92331ab14f7cd3beb71d7d0664213c3c245ee34e218bbc" },
  { id = "grant:ops-2", public_key = "4fba12886de6f3955e1e00122ecfa5f28f6143b4ebfd623426b31db6e3ba759b" },
  { id = "grant:ops-3", public_key = "05d820297454180f0a29826db77629efaf2866ce6321bdf1e36653fbce5f87fc" },
  { id = "grant:ops-4", public_key = "871aae4a90265130ec08636783f7c6967201557511093f2ebe5b1ec3b5759500" },
  { id = "grant:ops-5", public_key = "64b4461734432d8b1651171a2f4385948748665c876a377cd1722ef55389553b" }
]

[namespaces.validators.config.programmable_multisig]
enabled = false
policy_id = "builder-credits-auto-v1"
actors = ["automation.builder-credit-bot"]
max_grant_amount = 1000
```

## 3) Governance rollout procedure

1. Approve policy update through `governance.vote`.
2. Publish signed policy artifact + rules hash.
3. Roll out updated runtime config to every validator.
4. Restart validators in cohorts and verify namespace/rules hash parity.
5. Reject drift: any node with mismatched approver set must be corrected before
   rejoining write traffic.

## 4) Key custody expectations

- `grant_approvers` publish **public keys only**.
- Private issuer keys stay in isolated signer services or HSM/TPM custody.
- Keep grant issuer keys separate from validator consensus keys.
