# Civic Voting

Citizen Protocol includes a built-in civic voting system that enables verifiable, tamper-proof elections and governance decisions. Citizens cast ballots as ledger entries in the `civic.ballot` namespace, with double-vote prevention and proposal lifecycle enforcement at the protocol level.

## Architecture

```
Governance Body
  |
  |  OPEN_PROPOSAL entry -> civic.proposal namespace
  |  (title, description, voting period)
  |
  v
+------------------+     +----------------------------------+
| civic.proposal   |     | civic.ballot                     |
|                  |     |                                  |
| OPEN_PROPOSAL    |<----|  civic_voting_policy validates:  |
| CLOSE_PROPOSAL   |     |  - proposal exists & is open     |
|                  |     |  - choice is valid               |
|                  |     |  - author hasn't already voted   |
|                  |     |  + ctzn_citizenship_policy       |
|                  |     |    checks citizenship token      |
+------------------+     +----------------------------------+
                                |
                                v
                        GET /api/v1/civic/proposals/:id/tally
                        (live count: yes/no/abstain)
```

## Namespaces

### civic.proposal

Manages the proposal lifecycle. Only authorized governance bodies can open and close proposals.

| Action | Purpose | Fields |
|--------|---------|--------|
| `OPEN_PROPOSAL` | Opens a new proposal for voting | `title`, `description` |
| `CLOSE_PROPOSAL` | Closes a proposal, preventing further ballots | (none) |

### civic.ballot

Accepts citizen ballot entries. Each ballot is validated by:
1. `civic_voting_policy` - verifies proposal exists, is open, choice is valid, and no double voting
2. `ctzn_citizenship_policy` *(when configured)* - verifies the voter holds a qualifying CTZN citizenship token

| Action | Purpose | Fields |
|--------|---------|--------|
| `CAST_BALLOT` | Submits a citizen's vote | `proposal_id`, `choice` |

## Validation Rules

### civic_voting_policy

The `civic_voting_policy` namespace rule enforces:

1. **Proposal exists** - the referenced `proposal_id` must have an `OPEN_PROPOSAL` entry in the configured proposal namespace
2. **Proposal is open** - no `CLOSE_PROPOSAL` entry exists for the proposal
3. **Valid choice** - the ballot's `choice` must be in the configured `valid_choices` list
4. **No double voting** - the author must not have already cast a ballot for the same proposal

#### Configuration

```json
{
    "name": "civic_voting_policy",
    "config": {
        "proposal_namespace": "civic.proposal",
        "valid_choices": ["yes", "no", "abstain"]
    }
}
```

### Combining with Citizenship Policy

For citizenship-gated voting, add `ctzn_citizenship_policy` to the same namespace:

```json
[
    {
        "name": "ctzn_citizenship_policy",
        "config": {
            "ctzn_module_id": "ctzn-token.v1",
            "required_schema": "citizenship",
            "required_tier": 2,
            "current_block_height": 500000
        }
    },
    {
        "name": "civic_voting_policy",
        "config": {
            "proposal_namespace": "civic.proposal",
            "valid_choices": ["yes", "no", "abstain"]
        }
    }
]
```

Only gold-tier citizens with active, non-revoked, non-expired citizenship tokens can cast ballots.

## API Endpoints

### List Proposals

```
GET /api/v1/civic/proposals
```

Returns all proposals with their open/closed status.

### Get Proposal Detail

```
GET /api/v1/civic/proposals/:proposal_id
```

Returns a single proposal's metadata and status.

### Get Live Tally

```
GET /api/v1/civic/proposals/:proposal_id/tally
```

Returns the current vote count:

```json
{
    "proposal_id": "prop-budget-2026",
    "total_ballots": 3,
    "tally": {
        "yes": 2,
        "no": 1
    },
    "voters": [
        "did:citizen:alice",
        "did:citizen:bob",
        "did:citizen:carol"
    ]
}
```

### Submit a Ballot

Ballots are submitted as standard ledger entries via the entry submission endpoint:

```
POST /api/v1/entries/submit
```

```json
{
    "namespace": "civic.ballot",
    "action": "CAST_BALLOT",
    "object_id": "ballot-alice-prop-budget-2026",
    "payload": {
        "proposal_id": "prop-budget-2026",
        "choice": "yes"
    },
    "author": "did:citizen:alice",
    "signature": "<hex signature>"
}
```

## Security Properties

- **One citizen, one vote** - double voting is prevented at the ledger validation level, not in application code
- **Proposal lifecycle enforced** - ballots are rejected for non-existent or closed proposals
- **Citizenship-gated** - when configured with `ctzn_citizenship_policy`, only verified citizens can vote
- **Tamper-proof** - all ballots are committed on-chain with deterministic finality
- **Transparent** - anyone can verify the tally by reading the `civic.ballot` namespace
- **Auditable** - every ballot is tied to a DID with a cryptographic signature

## Use Cases

- **Elections** - national, regional, local elections with verifiable results
- **Referendums** - public policy questions with yes/no/abstain choices
- **Budget approvals** - participatory budgeting where citizens vote on spending
- **Board elections** - organizational governance for institutions and cooperatives
- **Constitutional amendments** - high-stakes governance changes requiring citizen approval

## Client Surfaces

The civic voting system is accessible through two client-facing applications:

### Web App (Vite + React)

Located at `civic-voting/` - a standalone Vite + React SPA providing:

- Proposal list with open/closed status badges
- Proposal detail view with description and metadata
- Live tally visualization with per-choice bar charts
- Wallet-connected ballot casting (yes/no/abstain)
- Real-time tally refresh after each ballot submission

Run `npm run dev` from the `civic-voting/` directory (starts on port 5174 with API proxy to the local node on 8081).

### Mobile Wallet (Flutter)

The mobile wallet includes a dedicated **Vote** tab in the bottom navigation bar. Features:

- Browse open proposals fetched from the connected network node
- View live tally with visual bar chart breakdown
- Cast signed ballots using the wallet's Ed25519 key
- Automatic signer DID derivation from the active wallet
- Network-aware (works across mainnet, testnet, local node)

The vote screen (`vote_screen.dart`) integrates with the existing wallet infrastructure - it uses the same `CryptoService` for signing, `CitizenApiService` for API calls, and `WalletProvider` for the active wallet, requiring no additional key management.

### API Integration Flow

```
1. Citizen opens Vote tab (mobile) or the civic-voting web app
2. App fetches: GET /api/v1/civic/proposals
3. Citizen selects a proposal
4. App fetches: GET /api/v1/civic/proposals/:id/tally
5. Citizen taps "Vote Yes"
6. App constructs ballot entry with proposal_id + choice
7. App signs the canonical JSON payload with wallet's Ed25519 key
8. App submits: POST /api/v1/entries/submit (CAST_BALLOT)
9. Ledger validates: civic_voting_policy + optional ctzn_citizenship_policy
10. App refreshes tally to show updated counts
```
