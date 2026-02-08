import { Injectable } from "@nestjs/common";
import { DatabaseService } from "./db.service";

@Injectable()
export class AppService {
  constructor(private readonly databaseService: DatabaseService) {}

  async getHealth() {
    const database = await this.databaseService.checkConnection();
    return {
      status: "ok",
      service: "citizen-dapp-api",
      database
    };
  }

  getCapabilities() {
    return {
      consensus: {
        name: "Deterministic Finality",
        detail: "Linear BFT consensus requiring ≥80% quorum with immediate finalization."
      },
      governance: {
        name: "Governance Engine",
        detail: "Validator-driven proposals and votes control protocol upgrades and validator sets."
      },
      validators: {
        name: "Validator Lifecycle",
        detail: "Identity-anchored admission, suspension, and removal with on-chain auditability."
      },
      namespaces: {
        name: "Namespace Rule Engine",
        detail: "Domain-specific rules enforce who can write and what proof is required."
      },
      ledger: {
        name: "Ledger Entries",
        detail: "Append-only event records secured with signatures and merkle roots."
      },
      security: {
        name: "Security Guarantees",
        detail: "Sybil resistance, deterministic finality, and governance-first safety controls."
      }
    };
  }

  getNamespaces() {
    return [
      {
        namespace: "identity.citizen",
        actions: ["REGISTER_IDENTITY", "UPDATE_CLAIM", "REVOKE_IDENTITY"]
      },
      {
        namespace: "registry.land",
        actions: ["REGISTER_PARCEL", "TRANSFER_OWNERSHIP", "ANNOTATE_DISPUTE"]
      },
      {
        namespace: "audit.procurement",
        actions: ["RECORD_EVENT", "LINK_DOCUMENT", "CLOSE_AUDIT"]
      },
      {
        namespace: "governance.vote",
        actions: ["SUBMIT_PROPOSAL", "CAST_VOTE", "EXECUTE_PROPOSAL"]
      }
    ];
  }

  getWorkflows() {
    return {
      identity: {
        entry_id: "uuid-identity-001",
        namespace: "identity.citizen",
        action: "REGISTER_IDENTITY",
        subject: "did:ledger:citizen:alexa",
        claims_hash: "bafybeigdyr...",
        signature: "sig:citizen-alexa",
        timestamp: 1736500000
      },
      land: {
        entry_id: "uuid-land-239-a",
        namespace: "registry.land",
        action: "TRANSFER_OWNERSHIP",
        parcel_id: "LOT-239-A",
        from: "did:ledger:citizen:alexa",
        to: "did:ledger:citizen:jamal",
        signature: "sig:citizen-alexa",
        timestamp: 1736500100
      },
      audit: {
        entry_id: "uuid-audit-402",
        namespace: "audit.procurement",
        action: "RECORD_EVENT",
        event: "BID_OPENED",
        document_hash: "sha256:9d35...",
        timestamp: 1736500200
      },
      governance: {
        proposal_type: "ADD_VALIDATOR",
        candidate_id: "did:ledger:validator:univ-x",
        pubkey: "bls:0xabc123",
        anchors: ["University of X"],
        voting_period: "14 days"
      }
    };
  }
}
