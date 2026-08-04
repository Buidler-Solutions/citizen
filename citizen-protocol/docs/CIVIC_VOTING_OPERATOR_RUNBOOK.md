# Civic Voting Operator Runbook

This runbook covers the end-to-end operation of Citizen Protocol's civic voting system — from genesis bootstrap and election creation to ballot submission, tally verification, and post-election audit. It covers both the **proposal model** (simple yes/no/abstain) and the **election model** (multi-position ballots with custom candidates).

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     civic.election                          │
│  OPEN_ELECTION { races: [president, senator, congress] }    │
│  CLOSE_ELECTION                                             │
└───────────────┬─────────────────────────────────────────────┘
                │ referenced by
┌───────────────▼─────────────────────────────────────────────┐
│                 civic.election.ballot                       │
│  CAST_BALLOT { election_id, selections: [                   │
│    { race_id: "president", candidate_ids: ["p1"] },         │
│    { race_id: "senator", candidate_ids: ["s1","s3"] }       │
│  ]}                                                         │
│  Validated by: election_ballot_policy                       │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                     civic.proposal                          │
│  OPEN_PROPOSAL { title, description }                       │
│  CLOSE_PROPOSAL                                             │
└───────────────┬─────────────────────────────────────────────┘
                │ referenced by
┌───────────────▼─────────────────────────────────────────────┐
│                      civic.ballot                           │
│  CAST_BALLOT { proposal_id, choice: "yes"|"no"|"abstain" }  │
│  Validated by: civic_voting_policy                          │
└─────────────────────────────────────────────────────────────┘
```

Four namespaces total. Two voting models, both enforced at the protocol level.

## Pre-flight: Namespace Bootstrap

The voting namespaces must be bootstrapped at genesis or via governance action before any ballots can be cast. The default genesis config includes all four:

```rust
// civic.proposal — simple proposal lifecycle
NamespaceRuleset {
    namespace: "civic.proposal",
    validators: [allowed_actions { actions: ["OPEN_PROPOSAL", "CLOSE_PROPOSAL"] }],
},

// civic.ballot — simple yes/no/abstain ballots
NamespaceRuleset {
    namespace: "civic.ballot",
    validators: [civic_voting_policy {
        proposal_namespace: "civic.proposal",
        valid_choices: ["yes", "no", "abstain"]
    }],
},

// civic.election — multi-position election lifecycle
NamespaceRuleset {
    namespace: "civic.election",
    validators: [allowed_actions { actions: ["OPEN_ELECTION", "CLOSE_ELECTION"] }],
},

// civic.election.ballot — multi-race ballots with candidate selection
NamespaceRuleset {
    namespace: "civic.election.ballot",
    validators: [election_ballot_policy {
        election_namespace: "civic.election"
    }],
},
```

### Verification

```bash
# After node startup, confirm all four namespaces exist:
curl -s http://127.0.0.1:8081/namespaces | jq '.namespaces[] | select(.namespace | startswith("civic")) | {namespace, rules_hash}'
```

Expected output should list `civic.proposal`, `civic.ballot`, `civic.election`, and `civic.election.ballot`.

---

## Model A: Proposal Voting (Simple Yes/No/Abstain)

Use this for referendums, budget approvals, policy questions, and single-proposition votes.

### 1. Open a Proposal

A governance body opens a proposal:

```bash
curl -s -X POST http://127.0.0.1:8081/api/v1/entries/submit \
  -H "Content-Type: application/json" \
  -d '{
    "entry_id": "'$(uuidgen)'",
    "namespace": "civic.proposal",
    "action": "OPEN_PROPOSAL",
    "object_id": "prop-budget-2026",
    "payload": {
      "title": "Fiscal Year 2026 National Budget",
      "description": "Approve the proposed national budget allocation for fiscal year 2026"
    },
    "author": "governance:vote",
    "signature": "placeholder",
    "timestamp": '$(date +%s)',
    "privacy_flag": false,
    "privacy_mode": "none"
  }' | jq .
```

### 2. Citizens Cast Ballots

Each citizen submits one `CAST_BALLOT` entry to `civic.ballot`:

```bash
curl -s -X POST http://127.0.0.1:8081/api/v1/entries/submit \
  -H "Content-Type: application/json" \
  -d '{
    "entry_id": "'$(uuidgen)'",
    "namespace": "civic.ballot",
    "action": "CAST_BALLOT",
    "object_id": "ballot-alice-prop-budget-2026",
    "payload": {
      "proposal_id": "prop-budget-2026",
      "choice": "yes"
    },
    "author": "did:citizen:alice",
    "signature": "placeholder",
    "timestamp": '$(date +%s)',
    "privacy_flag": false,
    "privacy_mode": "none"
  }' | jq .
```

### 3. Read Live Tally

```bash
curl -s http://127.0.0.1:8081/api/v1/civic/proposals/prop-budget-2026/tally | jq .
```

```json
{
  "proposal_id": "prop-budget-2026",
  "total_ballots": 327,
  "tally": { "abstain": 12, "no": 115, "yes": 200 },
  "voters": ["did:citizen:alice", "did:citizen:bob", "..."]
}
```

### 4. Close the Proposal

```bash
curl -s -X POST http://127.0.0.1:8081/api/v1/entries/submit \
  -H "Content-Type: application/json" \
  -d '{
    "entry_id": "'$(uuidgen)'",
    "namespace": "civic.proposal",
    "action": "CLOSE_PROPOSAL",
    "object_id": "prop-budget-2026",
    "payload": {},
    "author": "governance:vote",
    "signature": "placeholder",
    "timestamp": '$(date +%s)',
    "privacy_flag": false,
    "privacy_mode": "none"
  }' | jq .
```

After closure, any further ballots for this proposal will be rejected by `civic_voting_policy` with a "been closed" error.

### Validation Rules (civic_voting_policy)

| Check | Error message |
|-------|---------------|
| Action must be `CAST_BALLOT` | `unsupported action` |
| `payload.proposal_id` required | `proposal_id is required` |
| `payload.choice` required | `choice is required` |
| Choice in `valid_choices` | `not in valid choices` |
| Proposal exists and is open | `not open or does not exist` |
| Proposal not closed | `been closed` |
| No prior ballot from same author | `already cast a ballot` |

---

## Model B: Election Voting (Multi-Position with Candidates)

Use this for national elections, party primaries, local government races — any ballot where voters select candidates across multiple positions.

### 1. Design the Election Schema

Before submitting, design each race. A Philippine-style national election example:

```json
{
  "title": "2028 National and Local Elections",
  "races": [
    {
      "race_id": "president",
      "title": "President",
      "seat_type": "single",
      "max_selections": 1,
      "candidates": [
        { "candidate_id": "pres-alyssa-ong", "name": "Alyssa Ong", "party": "Partido ng Pagbabago" },
        { "candidate_id": "pres-bong-revilla", "name": "Bong Revilla Jr.", "party": "Lakas-CMD" },
        { "candidate_id": "pres-leni-robredo", "name": "Leni Robredo", "party": "Liberal Party" }
      ]
    },
    {
      "race_id": "senator",
      "title": "Senator (Top 12)",
      "seat_type": "multi",
      "max_selections": 12,
      "candidates": [
        { "candidate_id": "sen-mark-villar", "name": "Mark Villar", "party": "Nacionalista" },
        { "candidate_id": "sen-risa-hontiveros", "name": "Risa Hontiveros", "party": "Akbayan" },
        { "candidate_id": "sen-kiko-pangilinan", "name": "Kiko Pangilinan", "party": "Liberal" }
      ]
    },
    {
      "race_id": "congress-qc-d1",
      "title": "Congressman, Quezon City District 1",
      "seat_type": "single",
      "max_selections": 1,
      "candidates": [
        { "candidate_id": "qc1-juan-cruz", "name": "Juan Dela Cruz", "party": "Independent" },
        { "candidate_id": "qc1-maria-santos", "name": "Maria Santos", "party": "PPP" }
      ]
    },
    {
      "race_id": "mayor-manila",
      "title": "Mayor, City of Manila",
      "seat_type": "single",
      "max_selections": 1,
      "candidates": [
        { "candidate_id": "mnl-isko-moreno", "name": "Isko Moreno", "party": "Aksyon" },
        { "candidate_id": "mnl-honey-lacuna", "name": "Honey Lacuna", "party": "Asenso" }
      ]
    }
  ]
}
```

**Race field reference:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `race_id` | string | Yes | Unique within the election |
| `title` | string | Yes | Display name shown to voters |
| `seat_type` | `"single"` or `"multi"` | Yes | Determines radio vs checkbox UI |
| `max_selections` | number | Yes | Max candidates a voter can pick (1 for president, 12 for senators) |
| `candidates[]` | array | Yes | List of `{ candidate_id, name, party }` objects |

### 2. Open an Election

```bash
curl -s -X POST http://127.0.0.1:8081/api/v1/entries/submit \
  -H "Content-Type: application/json" \
  -d '{
    "entry_id": "'$(uuidgen)'",
    "namespace": "civic.election",
    "action": "OPEN_ELECTION",
    "object_id": "elec-2028-ph",
    "payload": {
      "title": "2028 National and Local Elections",
      "races": [...]  /* the full races array from above */
    },
    "author": "governance:vote",
    "signature": "placeholder",
    "timestamp": '$(date +%s)',
    "privacy_flag": false,
    "privacy_mode": "none"
  }' | jq .
```

### 3. Verify the Election is Listed

```bash
curl -s http://127.0.0.1:8081/api/v1/civic/elections | jq .
```

```json
{
  "elections": [
    {
      "election_id": "elec-2028-ph",
      "title": "2028 National and Local Elections",
      "opened_at": 1756675200,
      "opened_by": "governance:vote",
      "status": "open",
      "race_count": 4
    }
  ]
}
```

### 4. Citizens Cast Ballots

Each voter submits ONE entry to `civic.election.ballot` containing all their race selections:

```bash
curl -s -X POST http://127.0.0.1:8081/api/v1/entries/submit \
  -H "Content-Type: application/json" \
  -d '{
    "entry_id": "'$(uuidgen)'",
    "namespace": "civic.election.ballot",
    "action": "CAST_BALLOT",
    "object_id": "ballot-alice-elec-2028-ph",
    "payload": {
      "election_id": "elec-2028-ph",
      "selections": [
        { "race_id": "president", "candidate_ids": ["pres-leni-robredo"] },
        { "race_id": "senator", "candidate_ids": ["sen-risa-hontiveros", "sen-kiko-pangilinan"] },
        { "race_id": "congress-qc-d1", "candidate_ids": ["qc1-maria-santos"] },
        { "race_id": "mayor-manila", "candidate_ids": ["mnl-isko-moreno"] }
      ]
    },
    "author": "did:citizen:alice",
    "signature": "placeholder",
    "timestamp": '$(date +%s)',
    "privacy_flag": false,
    "privacy_mode": "none"
  }' | jq .
```

**Key behaviors:**
- Selections not made (missing races) are permitted — the voter abstains on those races
- All selections in the ballot are validated atomically: either the whole ballot is accepted or rejected
- A voter cannot submit a second ballot for the same election (double-vote rejection)
- Voters can select fewer candidates than `max_selections` (up-to-N, not exactly-N)

### 5. Read Live Election Tally

```bash
curl -s http://127.0.0.1:8081/api/v1/civic/elections/elec-2028-ph/tally | jq .
```

```json
{
  "election_id": "elec-2028-ph",
  "total_ballots": 24501,
  "races": [
    {
      "race_id": "president",
      "title": "President",
      "seat_type": "single",
      "max_selections": 1,
      "tally": {
        "pres-alyssa-ong": 8234,
        "pres-bong-revilla": 5612,
        "pres-leni-robredo": 10655
      },
      "total_ballots": 24501
    },
    {
      "race_id": "senator",
      "title": "Senator (Top 12)",
      "seat_type": "multi",
      "max_selections": 12,
      "tally": {
        "sen-mark-villar": 18200,
        "sen-risa-hontiveros": 21045,
        "sen-kiko-pangilinan": 19321
      },
      "total_ballots": 24501
    }
  ],
  "voters": ["did:citizen:alice", "did:citizen:bob", "..."]
}
```

The tally aggregates per-candidate counts across all ballots for each race independently. For `multi` seat races, multiple voters select different subsets — each candidate selection increments that candidate's count by 1.

### 6. Close the Election

```bash
curl -s -X POST http://127.0.0.1:8081/api/v1/entries/submit \
  -H "Content-Type: application/json" \
  -d '{
    "entry_id": "'$(uuidgen)'",
    "namespace": "civic.election",
    "action": "CLOSE_ELECTION",
    "object_id": "elec-2028-ph",
    "payload": {},
    "author": "governance:vote",
    "signature": "placeholder",
    "timestamp": '$(date +%s)',
    "privacy_flag": false,
    "privacy_mode": "none"
  }' | jq .
```

### Validation Rules (election_ballot_policy)

| Check | Error message |
|-------|---------------|
| Action must be `CAST_BALLOT` | `unsupported action` |
| `payload.election_id` required | `election_id is required` |
| `payload.selections` array required | `selections array is required` |
| Each selection has `race_id` | `each selection requires a race_id` |
| `race_id` exists in election | `not found in election` |
| All `candidate_id`s are in race's candidate list | `not valid for race` |
| Selections ≤ `max_selections` | `allows N selections but M were given` |
| No duplicate candidate in same race | `duplicate candidate` |
| Election exists and is open | `not open or does not exist` |
| Election not closed | `been closed` |
| No prior ballot from same author for same election | `already cast a ballot` |

---

## Citizenship Gating

Both voting models can be gated behind CTZN citizenship token verification by adding `ctzn_citizenship_policy` to the ballot namespace rules:

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

Tier levels for reference:

| Tier | Label | Typical use |
|------|-------|-------------|
| 0 | Registered | Basic registration, no voting rights |
| 1 | Silver | Local elections only |
| 2 | Gold | Full voting rights (national + local) |
| 3 | Platinum | Governance proposal authority |

When gated, ballots from non-citizens or expired/revoked tokens are rejected with a citizenship validation error before the election ballot policy even runs.

---

## Full API Reference

### Proposals

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/civic/proposals` | List all proposals with status |
| GET | `/api/v1/civic/proposals/:id` | Get proposal detail |
| GET | `/api/v1/civic/proposals/:id/tally` | Get live tally |

### Elections

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/civic/elections` | List all elections with race counts |
| GET | `/api/v1/civic/elections/:id` | Get election with all races and candidates |
| GET | `/api/v1/civic/elections/:id/tally` | Get per-race candidate tallies |

### Ballot Submission (both models)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/entries/submit` | Submit a ballot entry to the appropriate namespace |

Note: Ballots are submitted through the standard ledger entry pipeline, not a voting-specific endpoint. The namespace determines which policy validates the entry.

---

## Auditing & Verification

### Verify a Ballot Exists

```bash
# List all ballots for an election
curl -s http://127.0.0.1:8081/entries/civic.election.ballot | jq '.entries | map(select(.payload.election_id == "elec-2028-ph")) | length'
```

### Verify No Double Voting

```bash
# Check unique authors for a given election
curl -s http://127.0.0.1:8081/entries/civic.election.ballot | \
  jq '[.entries[] | select(.payload.election_id == "elec-2028-ph")] | group_by(.author) | map({author: .[0].author, count: length}) | map(select(.count > 1))'
```

Expected: empty array `[]`. Any non-empty result indicates a policy validation breach.

### Recompute Tally Independently

```bash
# Independent tally for president race
curl -s http://127.0.0.1:8081/entries/civic.election.ballot | \
  jq '[.entries[] | select(.payload.election_id == "elec-2028-ph") | .payload.selections[] | select(.race_id == "president") | .candidate_ids[]] | group_by(.) | map({candidate: .[0], votes: length})'
```

Compare against the API tally endpoint. They must match exactly.

### Full Vote Audit Trail

```bash
# Dump all ballots for an election with timestamps
curl -s http://127.0.0.1:8081/entries/civic.election.ballot | \
  jq '[.entries[] | select(.payload.election_id == "elec-2028-ph") | {author, timestamp, selections: .payload.selections}]' > election-audit.json
```

---

## Client Surfaces

### Web App (Vite + React)

```bash
cd civic-voting/
npm install
npm run dev      # starts on http://localhost:5174
npm run build    # production build to dist/
```

Dev server proxies `/api` to `http://127.0.0.1:8081`. For custom node URLs, set `VITE_NODE_URL=http://your-node:port` in `.env`.

### Mobile Wallet (Flutter)

The mobile wallet includes a Vote tab that browses elections, displays races with candidate selection, and submits signed ballots. Uses the wallet's Ed25519 key for ballot signing. See `wallet/mobile/lib/presentation/screens/vote_screen.dart`.

---

## Troubleshooting

### Ballot rejected: "proposal is not open or does not exist"

- Verify the `OPEN_PROPOSAL` or `OPEN_ELECTION` entry was accepted (HTTP 2xx)
- Check exact `proposal_id`/`election_id` matches `object_id` in the open entry
- Confirm the entry was submitted to the correct namespace (`civic.proposal` vs `civic.election`)

### Ballot rejected: "author has already cast a ballot"

Each voter can cast one ballot per proposal or election. To allow revoting, you must submit a governance proposal to change the policy (not recommended — double-voting prevention is a security property).

### Ballot rejected: "not valid for race"

- Verify the `candidate_id` exists in the election's race definition
- Check for typos in `candidate_id` values
- The candidate must exist in the `OPEN_ELECTION` payload at the time the ballot is submitted

### Ballot rejected: "allows N selections but M were given"

The ballot has more selections for a race than its `max_selections` allows. For a single-seat race like President, `max_selections` is 1 — selecting two candidates is rejected.

### Tally returns 404

The election or proposal ID may not have an `OPEN_*` entry in its namespace. Verify with:

```bash
curl -s http://127.0.0.1:8081/entries/civic.election | \
  jq '.entries | map(select(.action == "OPEN_ELECTION")) | .[].object_id'
```

### Namespace not found

If the voting namespaces aren't listed, they weren't bootstrapped at genesis. Check the node's genesis config for the four civic namespace rulesets. Nodes started without them will need a governance proposal to add them.

---

## Operational Checklist

### Pre-Election

- [ ] All four civic namespaces bootstrapped in genesis
- [ ] Election schema designed (races, candidates, `max_selections`)
- [ ] Citizenship policy configured if gating votes behind CTZN token
- [ ] `valid_choices` list confirmed for proposal model
- [ ] Client app deployed and tested with sample ballots
- [ ] Multiple validator nodes synced (for BFT fault tolerance)
- [ ] API rate limits and auth keys provisioned for production

### During Election

- [ ] Monitor `GET /api/v1/civic/elections/:id/tally` for participation rates
- [ ] Verify ballot submission error rate stays below threshold
- [ ] Check validator logs for policy validation rejections (may indicate attack attempts)
- [ ] Snapshot ledger state periodically for disaster recovery

### Post-Election

- [ ] Submit `CLOSE_ELECTION` / `CLOSE_PROPOSAL` entry
- [ ] Verify no ballots accepted after closure
- [ ] Export full audit trail (`entries/civic.election.ballot`)
- [ ] Reconcile independent tally against API tally
- [ ] Archive RocksDB snapshots for long-term retention

---

## Reference

- **Code**: `citizen-protocol/crates/ledger/src/lib.rs` — `civic_voting_policy` and `election_ballot_policy`
- **API**: `citizen-protocol/crates/api/src/lib.rs` — election and proposal handlers
- **Genesis**: `citizen-protocol/crates/node/src/main.rs` — default namespace bootstrap
- **Frontend**: `civic-voting/src/App.tsx` — multi-race ballot UI
- **Docs**: `docs/protocol/civic-voting.md` — protocol-level documentation
