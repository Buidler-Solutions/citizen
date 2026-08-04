# Civic Voting

Citizen Protocol includes a built-in civic voting system that enables verifiable, tamper-proof elections supporting both simple yes/no proposals and multi-race election ballots (president, senators, congressmen, etc.) — all cast atomically and validated at the protocol level.

## Architecture

```
Governance Body
  |
  |  OPEN_ELECTION entry -> civic.election namespace
  |  (races: president, senator, congressman, mayor...)
  |
  v
+---------------------+     +----------------------------------------+
| civic.election      |     | civic.election.ballot                  |
|                     |     |                                        |
| OPEN_ELECTION       |<----|  election_ballot_policy validates:     |
| CLOSE_ELECTION      |     |  - election exists & is open           |
|  ├ race: president  |     |  - each race_id exists in election     |
|  ├ race: senator    |     |  - candidate_ids are valid per race    |
|  ├ race: congress   |     |  - selections ≤ max_selections         |
|  └ race: mayor      |     |  - no duplicate candidates in race     |
+---------------------+     |  - author hasn't already voted         |
                            |  + ctzn_citizenship_policy             |
                            |    checks citizenship token            |
                            +----------------------------------------+
                                        |
                                        v
                            GET /api/v1/civic/elections/:id/tally
                            (per-race candidate tallies)

+------------------+     +----------------------------------+
| civic.proposal   |     | civic.ballot                     |
|                  |     |                                  |
| OPEN_PROPOSAL    |<----|  civic_voting_policy validates:  |
| CLOSE_PROPOSAL   |     |  - proposal exists & is open     |
|                  |     |  - choice is valid               |
|                  |     |  - author hasn't already voted   |
+------------------+     +----------------------------------+
```

The system supports **two voting models**:

| Model | Namespaces | Use case |
|-------|-----------|----------|
| **Proposal voting** | `civic.proposal` + `civic.ballot` | Simple yes/no/abstain referendums |
| **Election voting** | `civic.election` + `civic.election.ballot` | Multi-race elections with custom candidates |

## Election Model

### civic.election

Defines an election containing multiple races, each with its own candidates and selection rules.

| Action | Purpose | Fields |
|--------|---------|--------|
| `OPEN_ELECTION` | Opens a new election | `title`, `races[]` |
| `CLOSE_ELECTION` | Closes an election | (none) |

Each race within `races[]`:

| Field | Description |
|-------|-------------|
| `race_id` | Unique identifier within the election |
| `title` | Display name (e.g. "President", "Senator (Top 12)") |
| `seat_type` | `"single"` for one seat, `"multi"` for multiple seats |
| `max_selections` | Maximum candidates a voter may select (1 for president, 12 for senators) |
| `candidates[]` | Array of `{ candidate_id, name, party }` objects |

Example payload:

```json
{
    "title": "2026 National Elections",
    "races": [
        {
            "race_id": "president",
            "title": "President",
            "seat_type": "single",
            "max_selections": 1,
            "candidates": [
                {"candidate_id": "p1", "name": "Alice Reyes", "party": "Party A"},
                {"candidate_id": "p2", "name": "Bob Santos", "party": "Party B"}
            ]
        },
        {
            "race_id": "senator",
            "title": "Senator (Top 12)",
            "seat_type": "multi",
            "max_selections": 12,
            "candidates": [
                {"candidate_id": "s1", "name": "Carol Cruz", "party": "Party A"},
                {"candidate_id": "s2", "name": "Dave Lim", "party": "Party B"},
                {"candidate_id": "s3", "name": "Eve Tan", "party": "Party C"}
            ]
        }
    ]
}
```

### civic.election.ballot

Accepts citizen ballots with per-race candidate selections — all races cast atomically in a single entry.

| Action | Purpose | Fields |
|--------|---------|--------|
| `CAST_BALLOT` | Submits a multi-race ballot | `election_id`, `selections[]` |

Each selection in `selections[]` has `race_id` and `candidate_ids`:

```json
{
    "election_id": "elec-2026-national",
    "selections": [
        {"race_id": "president", "candidate_ids": ["p1"]},
        {"race_id": "senator", "candidate_ids": ["s1", "s3"]}
    ]
}
```

### election_ballot_policy

Validates every election ballot against:

1. **Election exists** — the referenced `election_id` must have an `OPEN_ELECTION` entry
2. **Election is open** — no `CLOSE_ELECTION` entry exists for the election
3. **Race exists** — each `race_id` in selections must match a race defined in the election
4. **Valid candidates** — each `candidate_id` must be in the race's candidate list
5. **Selection limit** — `candidate_ids.length` must not exceed `max_selections`
6. **No duplicates** — no duplicate candidate IDs within a single race
7. **No double voting** — the author must not have already cast a ballot for the same election

Configuration:

```json
{
    "name": "election_ballot_policy",
    "config": {
        "election_namespace": "civic.election"
    }
}
```

## Proposal Model (Simple Voting)

### civic.proposal

| Action | Purpose | Fields |
|--------|---------|--------|
| `OPEN_PROPOSAL` | Opens a proposal | `title`, `description` |
| `CLOSE_PROPOSAL` | Closes a proposal | (none) |

### civic.ballot

| Action | Purpose | Fields |
|--------|---------|--------|
| `CAST_BALLOT` | Casts a vote | `proposal_id`, `choice` |

### civic_voting_policy

Validates yes/no/abstain ballots:

1. Proposal exists and is open
2. `choice` is in `valid_choices` (default: `["yes", "no", "abstain"]`)
3. Author hasn't already voted on this proposal

Configuration:

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

Add `ctzn_citizenship_policy` to gate voting behind CTZN token ownership:

```json
[
    {
        "name": "ctzn_citizenship_policy",
        "config": {
            "ctzn_module_id": "ctzn-token.v1",
            "required_schema": "citizenship",
            "required_tier": 2
        }
    },
    {
        "name": "election_ballot_policy",
        "config": { "election_namespace": "civic.election" }
    }
]
```

## API Endpoints

### Elections

#### List Elections

```
GET /api/v1/civic/elections
```

Returns all elections with status and race count:

```json
{
    "elections": [
        {
            "election_id": "elec-2026-national",
            "title": "2026 National Elections",
            "opened_at": 1736600100,
            "opened_by": "governance:vote",
            "status": "open",
            "race_count": 4
        }
    ]
}
```

#### Get Election Detail

```
GET /api/v1/civic/elections/:election_id
```

Returns the full election including all races and candidates.

#### Get Election Tally

```
GET /api/v1/civic/elections/:election_id/tally
```

Returns per-race tallies with candidate vote counts:

```json
{
    "election_id": "elec-2026-national",
    "total_ballots": 157,
    "races": [
        {
            "race_id": "president",
            "title": "President",
            "seat_type": "single",
            "max_selections": 1,
            "tally": { "p1": 82, "p2": 75 },
            "total_ballots": 157
        },
        {
            "race_id": "senator",
            "title": "Senator (Top 12)",
            "seat_type": "multi",
            "max_selections": 12,
            "tally": { "s1": 140, "s2": 98, "s3": 112 },
            "total_ballots": 157
        }
    ],
    "voters": ["did:citizen:alice", "did:citizen:bob", ...]
}
```

### Proposals (Simple Voting)

#### List Proposals

```
GET /api/v1/civic/proposals
```

#### Get Proposal Detail

```
GET /api/v1/civic/proposals/:proposal_id
```

#### Get Proposal Tally

```
GET /api/v1/civic/proposals/:proposal_id/tally
```

### Submit a Ballot

Both simple and election ballots are submitted as standard ledger entries:

```
POST /api/v1/entries/submit
```

Simple ballot:
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

Election ballot:
```json
{
    "namespace": "civic.election.ballot",
    "action": "CAST_BALLOT",
    "object_id": "ballot-alice-elec-2026-national",
    "payload": {
        "election_id": "elec-2026-national",
        "selections": [
            {"race_id": "president", "candidate_ids": ["p1"]},
            {"race_id": "senator", "candidate_ids": ["s1", "s3", "s5"]}
        ]
    },
    "author": "did:citizen:alice",
    "signature": "<hex signature>"
}
```

## Security Properties

- **One citizen, one ballot per election** — double voting is prevented at the ledger validation level
- **Atomic multi-race ballots** — all race selections in a ballot are accepted or rejected together
- **Candidate validation** — invalid candidate IDs, excess selections, and duplicates are rejected
- **Election lifecycle enforced** — ballots are rejected for non-existent or closed elections
- **Citizenship-gated** — when configured with `ctzn_citizenship_policy`, only verified citizens can vote
- **Tamper-proof** — all ballots are committed on-chain with deterministic finality
- **Transparent** — anyone can verify tallies by reading the ledger namespaces
- **Auditable** — every ballot is tied to a DID with a cryptographic signature

## Client Surfaces

### Web App (Vite + React)

Located at `civic-voting/` — a standalone Vite + React SPA providing:

- **Election list** with open/closed status and race counts
- **Multi-race ballot view** — single-seat races use radio buttons, multi-seat races use checkboxes with max selection enforcement
- **Candidate cards** showing name and party affiliation
- **Atomic submission** — one "Cast Ballot" button submits all race selections
- **Live results** — switch to results view for per-race tally bars with candidate breakdowns
- **Wallet-connected** — signs and submits via Citizen wallet extension

Run `npm run dev` from the `civic-voting/` directory (starts on port 5174 with API proxy to the local node on 8081).

### Mobile Wallet (Flutter)

The mobile wallet includes a dedicated **Vote** tab in the bottom navigation bar providing browse, cast, and tally features for both proposals and elections via the existing wallet infrastructure.

## Use Cases

- **National elections** — president, senators, congressmen, all on one ballot
- **Local elections** — mayors, city councils, district representatives
- **Party primaries** — multi-candidate races with ranked selection
- **Referendums** — simple yes/no/abstain policy questions
- **Budget approvals** — participatory budgeting proposals
- **Board elections** — organizational governance
