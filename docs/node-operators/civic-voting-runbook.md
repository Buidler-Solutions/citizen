# Civic Voting Operator Runbook

This page covers the operational essentials for running elections on Citizen Protocol. For the full detailed runbook with curl examples, troubleshooting, and audit procedures, see **[CIVIC_VOTING_OPERATOR_RUNBOOK.md](https://github.com/greenarmor/citizen/blob/main/citizen-protocol/docs/CIVIC_VOTING_OPERATOR_RUNBOOK.md)** in the protocol repository.

## Quick Reference

### Two Voting Models

| Model | Namespace | Use case |
|-------|-----------|----------|
| **Proposal** | `civic.proposal` + `civic.ballot` | Yes/no/abstain referendums |
| **Election** | `civic.election` + `civic.election.ballot` | Multi-position ballots with candidates |

### API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/v1/civic/elections` | List elections |
| GET | `/api/v1/civic/elections/:id` | Full election with races + candidates |
| GET | `/api/v1/civic/elections/:id/tally` | Per-race candidate tallies |
| GET | `/api/v1/civic/proposals` | List proposals |
| GET | `/api/v1/civic/proposals/:id/tally` | Yes/no/abstain tally |
| POST | `/api/v1/entries/submit` | Submit ballot (both models) |

### Bootstrap

All four namespaces are bootstrapped in the default genesis. After node startup:

```bash
curl -s http://127.0.0.1:8081/namespaces | jq '.namespaces[] | select(.namespace | startswith("civic"))'
```

### Key Validation Checks

| Rule | What it enforces |
|------|-----------------|
| `election_ballot_policy` | Validates multi-race ballots: candidate eligibility, max selections, no duplicates, atomic submission |
| `civic_voting_policy` | Validates simple ballots: choice validity, proposal open, no double voting |
| `ctzn_citizenship_policy` | *(optional)* Gates voting behind CTZN token ownership |

### Election Schema

```json
{
  "races": [
    {
      "race_id": "president",
      "title": "President",
      "seat_type": "single",
      "max_selections": 1,
      "candidates": [
        {"candidate_id": "p1", "name": "Alice Reyes", "party": "Party A"}
      ]
    }
  ]
}
```

### Citizenhsip Gating

Add to ballot namespace validators to restrict voting to CTZN token holders:

```json
{"name": "ctzn_citizenship_policy", "config": {"required_tier": 2}}
```

### Web App

```bash
cd civic-voting/ && npm run dev   # http://localhost:5174
```
