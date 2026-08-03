# Governance

Governance is a first-class Citizen concept. All significant protocol changes - namespace creation, policy updates, validator admission - flow through the governance system.

## Governance Lifecycle

```
Proposal → Voting Period → Quorum Check → Activation
```

### 1. Proposal

Any authorized participant can submit a governance proposal. Proposals include:

- **Type** - namespace creation, policy update, validator admission, parameter change
- **Payload** - the specific change being proposed
- **Voting period** - how long the vote remains open

### 2. Voting

Validators cast votes during the voting period. Each validator gets one vote. Votes are signed and recorded on-chain.

### 3. Quorum Check

After the voting period closes, the governance engine evaluates:

- **Participation quorum** - minimum percentage of validators that must vote
- **Approval quorum** - minimum percentage of yes-votes among cast votes

If both thresholds are met, the proposal passes.

### 4. Activation

Passed proposals activate according to their type:

- **Namespace creation** - the new namespace is created with the proposed configuration
- **Policy updates** - namespace policies are updated
- **Validator admission** - the new validator is admitted to the consensus set
- **Parameter changes** - protocol parameters are updated

## Namespace Activation Readiness

Before a namespace becomes active, the governance engine validates its readiness:

- Required policies are configured
- Admission criteria are met
- Signature scheme is valid
- No conflicting namespace exists

## Governance Charter

The project includes a formal governance charter (see `citizen-protocol/docs/GOVERNANCE_CHARTER_V1.md`) that defines:

- Participant roles and permissions
- Proposal types and their requirements
- Voting periods and quorum thresholds
- Dispute resolution procedures
- Charter amendment process
