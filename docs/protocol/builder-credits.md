# Builder Credits

Builder credits are Citizen's **non-transferable capacity allocation system**. They are not tokens, cannot be bought or sold, and carry no speculative value. Their purpose is to allocate and reward legitimate write capacity on the network.

## Three Layers of Write Authorization

Builder credits do not work alone. Citizen uses three complementary layers, each answering a different question:

| Layer | Question | Mechanism |
|-------|----------|-----------|
| **KYC / identity verification** | Are you a real, accountable person? | Identity verification on-chain, tied to a DID |
| **API key** | Are you authenticated right now? | Per-integration key with scopes and rate limits |
| **Builder credits** | How much capacity have you earned? | Non-transferable allocation tied to reputation |

KYC prevents Sybil attacks. API keys provide authentication and coarse rate-limiting at the API edge. Builder credits provide the **economic and reputation layer** — quantifying how much write capacity a builder has earned and can consume.

Without credits, a compromised API key has unlimited blast radius. Credits cap the damage: even if a key is stolen, the attacker can only drain that writer's credit allocation, not flood the namespace indefinitely.

## The Reward Model

Builder credits serve a dual purpose: **blast-radius cap** and **reputation reward**.

### Baseline Allocation

Every KYC-verified builder starts with a baseline credit allocation — enough to be productive. This is issued via governance-approved `MULTISIG_CREDIT_GRANT` and debited by each `SPONSOR_USAGE` write.

### Earning Bonus Credits

Credits are not only consumed — they are **earned**. A builder who consistently submits valid, non-malicious transactions accumulates bonus credit allocations over time:

| Period Outcome | Credit Effect |
|----------------|---------------|
| No flagged transactions | Bonus credits granted next period |
| Flagged but resolved | No bonus, no penalty |
| Malicious transactions confirmed | Credits reduced or frozen |
| Repeated abuse | Writer suspended by governance |

This creates a **reputation gradient** rather than a binary active/suspended status:

```
Writer Track Record Over Time
│
│  ★★★★★  Trusted veteran  →  high capacity, governance fast-track
│  ★★★☆☆  Steady builder   →  baseline + moderate bonus
│  ★★☆☆☆  New writer       →  baseline allocation
│  ★☆☆☆☆  Under review     →  reduced allocation, monitoring
│  ✕       Suspended        →  no writes, governance review
```

### How Monitoring Feeds Credits

The network's existing transaction monitoring infrastructure already detects malicious and anomalous entries. In the reward model, this same monitoring signal drives credit decisions:

1. **Monitoring flags** suspicious entries for review
2. **Periodic evaluation** counts clean vs. flagged transactions per builder
3. **Governance or automated policy** grants bonus credits to builders with clean records
4. **Flagged builders** lose bonus eligibility or face capacity reduction

This closes the loop: the same system that detects abuse also rewards good behavior — automatically, without economic speculation.

## Why Not Just Gas?

| Problem with gas | How builder credits solve it |
|-------------------|------------------------------|
| Users must acquire tokens before writing | Builders sponsor writes via credits; end-users write for free |
| Token price volatility affects write cost | Credits are non-transferable and governance-priced, not market-priced |
| Wealthy actors can buy network dominance | Credits cannot be bought; they are allocated by governance and earned by reputation |
| Speculative token economy distracts from utility | Credits have no speculative value — they are pure capacity units |

## Non-Transferability

Credits are **strictly non-transferable**. The ledger enforces this at the protocol level:

- `TRANSFER_CREDITS` action is rejected
- Credits cannot be sent between builders
- Credits have no market price because they cannot be traded
- A builder's earned reputation stays with that builder's identity

This eliminates the entire class of economic attacks that plague token-based systems: no front-running, no MEV extraction, no token speculation, no whale dominance.

## Issuance

Credits are issued through `MULTISIG_CREDIT_GRANT`, which requires governance approval:

- **3-of-5 multisig** — at least 3 of 5 designated grant approvers must cryptographically sign each grant
- **Pinned to identity** — each grant is bound to a specific `builder_id` and public key
- **Audit-tracked** — every grant is a ledger entry with a deterministic receipt
- **Queryable** — `GET /api/v1/builder-credits/:builder_id` returns credited, sponsored, and available balances

## Sponsorship Flow

Builders use credits to sponsor end-user writes:

```
1. Wallet holder signs the business payload (e.g., a consent receipt)
2. Builder references its active credit grant (credit_grant_id)
3. Ledger validates: grant exists, grant is active, sufficient balance
4. Ledger records a deterministic sponsorship receipt
5. Builder's credit balance is debited
```

End-users never need credits — they only need a wallet and a builder willing to sponsor their writes. This keeps the system builder-first while remaining free for citizens.

## Anti-Abuse Controls

| Control | Mechanism |
|---------|-----------|
| **Daily spend cap** | `max_daily_spend` limits total credits consumed per builder per day |
| **Unique sponsorship IDs** | Each sponsored write requires a unique `sponsorship_id` — prevents replay |
| **Per-writer rate limits** | Namespace-level rate limits independent of credit balance |
| **Writer suspension** | Governance can hard-suspend any writer regardless of credit balance |
| **Credit reduction** | Malicious behavior reduces future credit allocation (soft penalty before suspension) |

## Summary

Builder credits are not a gas replacement bolted onto a BFT chain. They are a **reputation-based capacity system** layered on top of identity verification and API authentication. The result is a network where:

- Spam is prevented without speculative economics
- Good builders earn more capacity over time
- Compromised keys have bounded blast radius
- Citizens write for free through builder sponsorship
- No one can buy network dominance
