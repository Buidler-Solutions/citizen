#![no_std]
#![no_main]

/// Voting Trust Contract — demonstrates full programming logic:
/// - State machine (proposed → active → passed/rejected)
/// - Loops and iteration
/// - Mathematical computation (quorum, weighted voting)
/// - Complex data structures (nested structs, maps)
/// - Conditional branching
/// - Time-based logic (block height deadlines)
/// - Delegation graphs (transitive lookups)
/// - Cross-contract calls

extern crate alloc;

#[global_allocator]
static ALLOC: citizen_contract_sdk::Allocator = citizen_contract_sdk::Allocator;

use alloc::vec::Vec;
use alloc::string::String;
use citizen_contract_sdk::prelude::*;
use citizen_contract_derive::contract;
use serde::{Serialize, Deserialize};

// ── Domain types ───────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
enum ProposalState {
    Proposed,
    Active,
    Passed,
    Rejected,
    Executed,
}

impl Default for ProposalState {
    fn default() -> Self { ProposalState::Proposed }
}

#[derive(Serialize, Deserialize)]
struct Proposal {
    id: String,
    title: String,
    proposer: String,
    state: ProposalState,
    for_votes: u64,
    against_votes: u64,
    start_block: u64,
    end_block: u64,
    quorum_bps: u32,        // 6667 = 66.67%
    executed: bool,
}

#[derive(Serialize, Deserialize)]
struct VoteRecord {
    voter: String,
    support: bool,
    weight: u64,
    block: u64,
}

// ── Contract ───────────────────────────────────────────────────

#[contract]
mod contract {
    use super::*;

    // ── Create a proposal (state transition: → Active) ──────────

    pub fn create_proposal(ctx: Context) -> Result<Response> {
        let id: String = ctx.param("proposal_id")?;
        let title: String = ctx.param("title")?;
        let proposer: String = ctx.param("proposer")?;
        let duration_blocks: u64 = ctx.param_or("duration", 1000);
        let quorum_bps: u32 = ctx.param_or("quorum_bps", 6667);

        let proposals = ctx.storage().map::<String, Proposal>("proposal");

        // Business rule: no duplicate proposals
        if proposals.exists(&id) {
            return Err(ContractError::msg("proposal already exists"));
        }

        let block = ctx.block_height();

        let proposal = Proposal {
            id: id.clone(),
            title,
            proposer,
            state: ProposalState::Active,
            for_votes: 0,
            against_votes: 0,
            start_block: block,
            end_block: block + duration_blocks,
            quorum_bps,
            executed: false,
        };

        proposals.save(&id, &proposal)?;

        ctx.emit("ProposalCreated", &json!({"id": id}));
        Ok(Response::success())
    }

    // ── Vote on a proposal (stateful mutation) ──────────────────

    pub fn vote(ctx: Context) -> Result<Response> {
        let proposal_id: String = ctx.param("proposal_id")?;
        let voter: String = ctx.param("voter")?;
        let support: bool = ctx.param("support")?;

        let proposals = ctx.storage().map::<String, Proposal>("proposal");
        let votes = ctx.storage().map::<String, VoteRecord>("vote");

        // Business rule: proposal must be active
        let mut proposal: Proposal = proposals
            .load(&proposal_id)?
            .ok_or_else(|| ContractError::msg("proposal not found"))?;

        if proposal.state != ProposalState::Active {
            return Err(ContractError::msg("proposal is not active"));
        }

        // Business rule: voting window
        let block = ctx.block_height();
        if block > proposal.end_block {
            // Auto-transition: Active → Rejected (expired)
            proposal.state = ProposalState::Rejected;
            proposals.save(&proposal_id, &proposal)?;
            return Err(ContractError::msg("voting period has ended"));
        }

        // Business rule: one vote per voter per proposal
        let vote_key = format!("{proposal_id}:{voter}");
        if votes.exists(&vote_key) {
            return Err(ContractError::msg("already voted"));
        }

        // Calculate voting weight (with delegation)
        let weight = resolve_voting_weight(&ctx, &voter)?;

        // Update tally
        if support {
            proposal.for_votes += weight;
        } else {
            proposal.against_votes += weight;
        }

        // Record the vote
        votes.save(&vote_key, &VoteRecord {
            voter: voter.clone(),
            support,
            weight,
            block,
        })?;

        proposals.save(&proposal_id, &proposal)?;

        ctx.emit("VoteCast", &json!({
            "proposal": proposal_id,
            "voter": voter,
            "support": support,
            "weight": weight
        }));

        Ok(Response::data(json!({"weight": weight})))
    }

    // ── Finalize a proposal (state machine transition) ──────────

    pub fn finalize(ctx: Context) -> Result<Response> {
        let proposal_id: String = ctx.param("proposal_id")?;

        let proposals = ctx.storage().map::<String, Proposal>("proposal");

        let mut proposal: Proposal = proposals
            .load(&proposal_id)?
            .ok_or_else(|| ContractError::msg("proposal not found"))?;

        // State machine: only Active proposals can be finalized
        if proposal.state != ProposalState::Active {
            return Err(ContractError::msg("proposal is not active"));
        }

        // Business rule: voting period must be over
        let block = ctx.block_height();
        if block <= proposal.end_block {
            return Err(ContractError::msg("voting period not over"));
        }

        // Math: calculate results
        let total_votes = proposal.for_votes + proposal.against_votes;
        let total_eligible = get_total_eligible_voters(&ctx);

        // Quorum check: did enough people vote?
        let participation_pct = if total_eligible > 0 {
            (total_votes * 10000) / total_eligible
        } else {
            0
        };

        let met_quorum = participation_pct >= proposal.quorum_bps as u64;

        // Majority check: more for than against
        let passed = met_quorum && proposal.for_votes > proposal.against_votes;

        // State transition
        proposal.state = if passed {
            ProposalState::Passed
        } else {
            ProposalState::Rejected
        };

        proposals.save(&proposal_id, &proposal)?;

        ctx.emit("ProposalFinalized", &json!({
            "id": proposal_id,
            "state": format!("{:?}", proposal.state),
            "for": proposal.for_votes,
            "against": proposal.against_votes,
            "participation_bps": participation_pct
        }));

        Ok(Response::data(json!({
            "passed": passed,
            "state": format!("{:?}", proposal.state),
            "for_votes": proposal.for_votes,
            "against_votes": proposal.against_votes,
            "participation_bps": participation_pct,
            "met_quorum": met_quorum,
        })))
    }

    // ── Delegation (transitive graph walk) ──────────────────────

    pub fn delegate(ctx: Context) -> Result<Response> {
        let delegator: String = ctx.param("delegator")?;
        let delegatee: String = ctx.param("delegatee")?;

        // Business rule: cannot delegate to self
        if delegator == delegatee {
            return Err(ContractError::msg("cannot delegate to self"));
        }

        // Business rule: detect cycles (walk the chain)
        let mut current = delegatee.clone();
        let mut depth = 0u32;
        loop {
            if current == delegator {
                return Err(ContractError::msg("delegation cycle detected"));
            }
            let delegations = ctx.storage().map::<String, String>("delegation");
            match delegations.load(&current)? {
                Some(next) => current = next,
                None => break,
            }
            depth += 1;
            if depth > 10 {
                return Err(ContractError::msg("delegation chain too deep"));
            }
        }

        let delegations = ctx.storage().map::<String, String>("delegation");
        delegations.save(&delegator, &delegatee)?;

        ctx.emit("Delegated", &json!({
            "delegator": delegator,
            "delegatee": delegatee
        }));

        Ok(Response::success())
    }

    // ── Query: get proposal details ─────────────────────────────

    pub fn get_proposal(ctx: Context) -> Result<Response> {
        let id: String = ctx.param("proposal_id")?;

        let proposal: Proposal = ctx.storage()
            .map::<String, Proposal>("proposal")
            .load(&id)?
            .ok_or_else(|| ContractError::msg("not found"))?;

        let block = ctx.block_height();
        let time_remaining = if block < proposal.end_block {
            proposal.end_block - block
        } else {
            0
        };

        Ok(Response::data(json!({
            "id": proposal.id,
            "title": proposal.title,
            "proposer": proposal.proposer,
            "state": format!("{:?}", proposal.state),
            "for_votes": proposal.for_votes,
            "against_votes": proposal.against_votes,
            "start_block": proposal.start_block,
            "end_block": proposal.end_block,
            "time_remaining_blocks": time_remaining,
            "quorum_bps": proposal.quorum_bps,
        })))
    }

    // ── Query: iterate all votes on a proposal ──────────────────

    pub fn get_votes(ctx: Context) -> Result<Response> {
        let proposal_id: String = ctx.param("proposal_id")?;

        let vote_list = ctx.storage()
            .get_str(&format!("votes_for:{proposal_id}"))
            .unwrap_or_default();

        let mut results = Vec::new();

        // Parse comma-separated vote keys and load each
        for key in vote_list.split(',') {
            if key.is_empty() { continue; }
            if let Some(record) = ctx.storage()
                .map::<String, VoteRecord>("vote")
                .load(&key.to_string())?
            {
                results.push(json!({
                    "voter": record.voter,
                    "support": record.support,
                    "weight": record.weight,
                    "block": record.block,
                }));
            }
        }

        Ok(Response::data(json!({"votes": results, "count": results.len()})))
    }

    // ── Internal helpers ────────────────────────────────────────

    fn resolve_voting_weight(ctx: &Context, voter: &str) -> Result<u64> {
        // Base weight: 1 voter = 1 vote (or look up from a registry)
        let base: u64 = 1;

        // Check if this voter has delegated TO someone else
        // If so, they've given up their vote — weight is 0
        let delegations = ctx.storage().map::<String, String>("delegation");
        if delegations.exists(&voter.to_string()) {
            return Ok(0); // Delegated away their vote
        }

        // Add delegated weight: find everyone who delegated TO this voter
        // Walk the delegation list (simplified — in production, maintain a reverse index)
        let mut total = base;

        // Check known delegators
        let delegator_list = ctx.storage()
            .get_str("delegators")
            .unwrap_or_default();

        for did in delegator_list.split(',') {
            if did.is_empty() { continue; }
            let target: Option<String> = delegations.load(&did.to_string())?;
            if target.as_deref() == Some(voter) {
                total += 1; // Add delegated weight
            }
        }

        Ok(total)
    }

    fn get_total_eligible_voters(ctx: &Context) -> u64 {
        // Could cross-contract call to a citizen registry:
        // call_module("ctzn-token", r#"{"operation":"total_supply"}"#)

        // For now, count registered voters
        let count_str = ctx.storage().get_str("voter_count").unwrap_or_default();
        count_str.parse::<u64>().unwrap_or(100) // Default to 100 eligible
    }
}
