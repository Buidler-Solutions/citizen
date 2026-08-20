import { buildSignedEntry } from "../../../../chain/sdk/src/index.ts";
import type { ChainModule } from "./chain.module.ts";
import type { Store } from "../store.ts";
import { badRequest } from "../http.ts";

/**
 * Governance module — civic proposal surface for TreasureNet parameter
 * changes (oracle rotation, fee policy, module upgrades). Node mode submits
 * signed PROPOSE/APPROVED/REJECTED entries to the on-chain `governance`
 * namespace exactly like the deploy bootstrap; mock mode keeps proposals in
 * the store so both surfaces behave identically.
 *
 * Decisions are service-keyed in node mode: the operator holds the admin
 * key (TREASURENET_SERVICE_KEY) that the modules already trust for
 * reconfiguration, so a governance approval here is actionable.
 */
export interface GovernanceProposal {
  proposal_id: string;
  title: string;
  parameters: Record<string, unknown>;
  status: "proposed" | "approved" | "rejected";
  decided_at?: number;
  created_at: number;
}

export class GovernanceModule {
  private readonly chain: ChainModule;
  private readonly store: Store;

  constructor(chain: ChainModule, store: Store) {
    this.chain = chain;
    this.store = store;
  }

  async propose(input: {
    proposal_id?: string;
    title?: string;
    parameters?: Record<string, unknown>;
  }): Promise<GovernanceProposal> {
    if (!input?.title) badRequest("MissingFields", "title is required");
    const proposalId = input.proposal_id ?? `proposal-${randomProposalId()}`;
    const parameters = input.parameters ?? {};
    const createdAt = Date.now();

    if (this.chain.nodeClient) {
      const entry = buildSignedEntry(
        {
          namespace: "governance",
          action: "PROPOSE",
          object_id: proposalId,
          payload: { proposal_id: proposalId, title: input!.title, parameters, status: "proposed" },
          author: this.chain.config.serviceDid,
        },
        this.chain.config.serviceKeyHex
      );
      const response = await this.chain.nodeClient.submitEntry(entry);
      if (response.status >= 300) {
        throw new Error(`governance propose rejected: HTTP ${response.status}`);
      }
    }
    const proposal: GovernanceProposal = {
      proposal_id: proposalId,
      title: input!.title,
      parameters,
      status: "proposed",
      created_at: createdAt,
    };
    this.store.govProposals.set(proposalId, proposal);
    this.store.recordEvent("governance.proposed", "governance", {
      proposal_id: proposalId,
      title: input!.title,
      parameters,
    });
    return proposal;
  }

  async decide(input: { proposal_id: string; decision: "approved" | "rejected" }): Promise<GovernanceProposal> {
    if (!input?.proposal_id || (input.decision !== "approved" && input.decision !== "rejected")) {
      badRequest("MissingFields", "proposal_id and decision (approved|rejected) are required");
    }
    const proposal = this.store.govProposals.get(input!.proposal_id);
    if (!proposal) badRequest("ProposalNotFound", `proposal ${input!.proposal_id} does not exist`);
    if (proposal!.status !== "proposed") {
      badRequest("ProposalDecided", `proposal ${input!.proposal_id} is already ${proposal!.status}`);
    }
    const action = input!.decision === "approved" ? "APPROVED" : "REJECTED";
    if (this.chain.nodeClient) {
      const entry = buildSignedEntry(
        {
          namespace: "governance",
          action,
          object_id: input!.proposal_id,
          payload: { proposal_id: input!.proposal_id, status: input!.decision, decided_by: this.chain.config.serviceDid },
          author: this.chain.config.serviceDid,
        },
        this.chain.config.serviceKeyHex
      );
      const response = await this.chain.nodeClient.submitEntry(entry);
      if (response.status >= 300) {
        throw new Error(`governance ${input!.decision} rejected: HTTP ${response.status}`);
      }
    }
    proposal!.status = input!.decision;
    proposal!.decided_at = Date.now();
    this.store.govProposals.set(input!.proposal_id, proposal!);
    this.store.recordEvent(`governance.${input!.decision}`, "governance", {
      proposal_id: input!.proposal_id,
    });
    return proposal!;
  }

  async list(): Promise<GovernanceProposal[]> {
    if (this.chain.nodeClient) {
      try {
        const entries = (await this.chain.nodeClient.listEntries("governance")) as {
          entries?: Array<{ action?: string; object_id?: string; payload?: Record<string, unknown>; timestamp?: number }>;
        };
        const proposals = new Map<string, GovernanceProposal>();
        const decisions: Array<{ id: string; action?: string; timestamp?: number }> = [];
        for (const entry of entries.entries ?? []) {
          const id = entry.object_id ?? "";
          if (!id) continue;
          if (entry.action === "PROPOSE") {
            proposals.set(id, {
              proposal_id: id,
              title: String(entry.payload?.title ?? id),
              parameters: (entry.payload?.parameters as Record<string, unknown>) ?? {},
              status: "proposed",
              created_at: (entry.timestamp ?? 0) * 1000,
            });
          } else if (entry.action === "APPROVED" || entry.action === "REJECTED") {
            decisions.push({ id, action: entry.action, timestamp: entry.timestamp });
          }
        }
        decisions.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
        for (const decision of decisions) {
          const existing = proposals.get(decision.id);
          if (existing) {
            existing.status = decision.action === "APPROVED" ? "approved" : "rejected";
            existing.decided_at = (decision.timestamp ?? 0) * 1000;
          }
        }
        if (proposals.size > 0) return [...proposals.values()].sort((a, b) => b.created_at - a.created_at);
      } catch {
        // Node unreachable: fall through to the local projection.
      }
    }
    return [...this.store.govProposals.values()].sort((a, b) => b.created_at - a.created_at);
  }
}

function randomProposalId(): string {
  return Math.random().toString(36).slice(2, 10);
}
