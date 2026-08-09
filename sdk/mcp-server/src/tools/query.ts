import type { CitizenClient } from "../client.js";

export interface ToolContext {
  client: CitizenClient;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

const limitParam = {
  type: "number",
  description: "Maximum number of results to return",
  default: 50,
} as const;

const cursorParam = {
  type: "string",
  description: "Pagination cursor from a previous response",
} as const;

const didParam = {
  type: "string",
  description: "Decentralized identifier (e.g. did:web:example.com:user:alice)",
} as const;

const idParam = (desc: string) => ({
  type: "string",
  description: desc,
} as const);

export const queryTools: ToolDefinition[] = [
  {
    name: "citizen_health",
    description: "Check if the Citizen node is online and healthy. Returns {\"status\":\"ok\"} when the node is running.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, { client }) => client.getHealth(),
  },
  {
    name: "citizen_list_blocks",
    description: "List recent blocks from the ledger. Returns paginated block headers with height, hash, proposer, and timestamp.",
    inputSchema: {
      type: "object",
      properties: { limit: limitParam, cursor: cursorParam },
    },
    handler: async (args, { client }) =>
      client.listBlocks(args.limit as number | undefined, args.cursor as string | undefined),
  },
  {
    name: "citizen_get_block",
    description: "Get a single block by its height, including all entries within the block.",
    inputSchema: {
      type: "object",
      properties: { height: { type: "number", description: "Block height (0-indexed)" } },
      required: ["height"],
    },
    handler: async (args, { client }) => client.getBlock(args.height as number),
  },
  {
    name: "citizen_list_namespaces",
    description: "List all active namespaces on the ledger. Each namespace has its own rules, writers, and validators.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, { client }) => client.listNamespaces(),
  },
  {
    name: "citizen_list_entries",
    description: "List entries within a specific namespace. Entries are the fundamental records on the Citizen ledger — each contains an action, object_id, payload, and signature.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: idParam("Namespace identifier (e.g. 'gov.civic', 'builder.credits', 'forms.commitment')"),
        limit: limitParam,
        cursor: cursorParam,
      },
      required: ["namespace"],
    },
    handler: async (args, { client }) =>
      client.listEntries(args.namespace as string, args.limit as number | undefined, args.cursor as string | undefined),
  },
  {
    name: "citizen_get_receipt",
    description: "Get a deterministic receipt by its UUID. Receipts contain the validation outcome, finality proof (block height + hash + commit proof), and any off-chain commitments. This is how you verify a transaction was finalized.",
    inputSchema: {
      type: "object",
      properties: { receiptId: idParam("Receipt UUID") },
      required: ["receiptId"],
    },
    handler: async (args, { client }) => client.getReceipt(args.receiptId as string),
  },
  {
    name: "citizen_resolve_did",
    description: "Resolve a DID (decentralized identifier) to its DID document, including controller, status (active/revoked), and claims hash.",
    inputSchema: {
      type: "object",
      properties: { did: didParam },
      required: ["did"],
    },
    handler: async (args, { client }) => client.resolveDid(args.did as string),
  },
  {
    name: "citizen_get_kyc_status",
    description: "Check the KYC (Know Your Customer) verification status for a specific DID.",
    inputSchema: {
      type: "object",
      properties: { did: didParam },
      required: ["did"],
    },
    handler: async (args, { client }) => client.getKycStatus(args.did as string),
  },
  {
    name: "citizen_list_kyc",
    description: "List all KYC verification records on the ledger.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, { client }) => client.listKyc(),
  },
  {
    name: "citizen_get_builder_credits",
    description: "Get the builder credit balance for a specific builder ID. Builder credits enable non-speculative, sponsored usage of the network.",
    inputSchema: {
      type: "object",
      properties: { builderId: idParam("Builder identifier (typically a DID)") },
      required: ["builderId"],
    },
    handler: async (args, { client }) => client.getBuilderCredits(args.builderId as string),
  },
  {
    name: "citizen_get_asset_positions",
    description: "Get all asset positions for an account. Assets are namespace-scoped resources controlled by asset-control policies.",
    inputSchema: {
      type: "object",
      properties: { accountId: idParam("Account identifier (typically a DID)") },
      required: ["accountId"],
    },
    handler: async (args, { client }) => client.getAssetPositions(args.accountId as string),
  },
  {
    name: "citizen_get_module_runtime",
    description: "Get the runtime state of a WASM module deployed on the network. Modules are governance-gated execution units.",
    inputSchema: {
      type: "object",
      properties: { moduleId: idParam("Module identifier (typically a hash or registered name)") },
      required: ["moduleId"],
    },
    handler: async (args, { client }) => client.getModuleRuntime(args.moduleId as string),
  },
  {
    name: "citizen_get_interop_status",
    description: "Get cross-chain interop status for a specific object. Interop adapters are governed bridges to other blockchain networks.",
    inputSchema: {
      type: "object",
      properties: { objectId: idParam("Object identifier on the interop adapter") },
      required: ["objectId"],
    },
    handler: async (args, { client }) => client.getInteropStatus(args.objectId as string),
  },
  {
    name: "citizen_get_governance_proposals",
    description: "List all governance proposals. Governance covers validator admission/removal, namespace updates, emergency actions, and parameter changes.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, { client }) => client.getGovernanceProposals(),
  },
  {
    name: "citizen_list_civic_proposals",
    description: "List all civic proposals (ballot measures, policy initiatives) on the ledger.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, { client }) => client.listCivicProposals(),
  },
  {
    name: "citizen_get_civic_proposal",
    description: "Get details of a specific civic proposal by its ID.",
    inputSchema: {
      type: "object",
      properties: { proposalId: idParam("Civic proposal identifier") },
      required: ["proposalId"],
    },
    handler: async (args, { client }) => client.getCivicProposal(args.proposalId as string),
  },
  {
    name: "citizen_get_civic_tally",
    description: "Get the current vote tally for a civic proposal.",
    inputSchema: {
      type: "object",
      properties: { proposalId: idParam("Civic proposal identifier") },
      required: ["proposalId"],
    },
    handler: async (args, { client }) => client.getCivicProposalTally(args.proposalId as string),
  },
  {
    name: "citizen_list_civic_elections",
    description: "List all civic elections on the ledger.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, { client }) => client.listCivicElections(),
  },
  {
    name: "citizen_get_civic_election",
    description: "Get details of a specific civic election by its ID.",
    inputSchema: {
      type: "object",
      properties: { electionId: idParam("Election identifier") },
      required: ["electionId"],
    },
    handler: async (args, { client }) => client.getCivicElection(args.electionId as string),
  },
  {
    name: "citizen_get_election_tally",
    description: "Get the current tally for a civic election, showing vote counts per candidate or option.",
    inputSchema: {
      type: "object",
      properties: { electionId: idParam("Election identifier") },
      required: ["electionId"],
    },
    handler: async (args, { client }) => client.getCivicElectionTally(args.electionId as string),
  },
  {
    name: "citizen_get_election_ballots",
    description: "List submitted ballots for a civic election. Each ballot is a privacy-preserving vote record.",
    inputSchema: {
      type: "object",
      properties: { electionId: idParam("Election identifier") },
      required: ["electionId"],
    },
    handler: async (args, { client }) => client.getCivicElectionBallots(args.electionId as string),
  },
  {
    name: "citizen_check_civic_admin",
    description: "Check whether a DID is a registered civic administrator with elevated permissions.",
    inputSchema: {
      type: "object",
      properties: { did: didParam },
      required: ["did"],
    },
    handler: async (args, { client }) => client.checkCivicAdmin(args.did as string),
  },
  {
    name: "citizen_get_civic_kyc_public_key",
    description: "Get the public key used by the civic system for KYC verification.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, { client }) => client.getCivicKycPublicKey(),
  },
  {
    name: "citizen_check_civic_registry",
    description: "Check the civic registry status for a DID (registered citizen, verified identity, etc.).",
    inputSchema: {
      type: "object",
      properties: { did: didParam },
      required: ["did"],
    },
    handler: async (args, { client }) => client.checkCivicRegistry(args.did as string),
  },
  {
    name: "citizen_check_voter_eligibility",
    description: "Check if a specific DID is eligible to vote in a given election.",
    inputSchema: {
      type: "object",
      properties: {
        electionId: idParam("Election identifier"),
        did: didParam,
      },
      required: ["electionId", "did"],
    },
    handler: async (args, { client }) =>
      client.checkVoterEligibility(args.electionId as string, args.did as string),
  },
  {
    name: "citizen_get_ctzn_status",
    description: "Get the status of a CTZN token module (supply, metadata, configuration).",
    inputSchema: {
      type: "object",
      properties: { moduleId: idParam("CTZN token module identifier") },
      required: ["moduleId"],
    },
    handler: async (args, { client }) => client.getCtznStatus(args.moduleId as string),
  },
  {
    name: "citizen_get_ctzn_holders",
    description: "List all token holders for a CTZN token module.",
    inputSchema: {
      type: "object",
      properties: { moduleId: idParam("CTZN token module identifier") },
      required: ["moduleId"],
    },
    handler: async (args, { client }) => client.getCtznHolders(args.moduleId as string),
  },
  {
    name: "citizen_get_ctzn_balance",
    description: "Check the CTZN token balance or holding status for a specific DID.",
    inputSchema: {
      type: "object",
      properties: {
        moduleId: idParam("CTZN token module identifier"),
        did: didParam,
      },
      required: ["moduleId", "did"],
    },
    handler: async (args, { client }) => client.getCtznBalance(args.moduleId as string, args.did as string),
  },
  {
    name: "citizen_get_file_manifest",
    description: "Get metadata for an off-chain encrypted file manifest by its ID.",
    inputSchema: {
      type: "object",
      properties: { manifestId: idParam("File manifest identifier") },
      required: ["manifestId"],
    },
    handler: async (args, { client }) => client.getFileManifest(args.manifestId as string),
  },
  {
    name: "citizen_list_file_alerts",
    description: "List file access alerts (unauthorized access attempts, revocation events, etc.).",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, { client }) => client.listFileAlerts(),
  },
  {
    name: "citizen_get_payload_field_refs",
    description: "Get payload field commitment references for a specific entry. Used when entries store encrypted data with per-field ACLs.",
    inputSchema: {
      type: "object",
      properties: {
        entryId: idParam("Entry UUID"),
        namespace: idParam("Namespace identifier"),
      },
      required: ["entryId", "namespace"],
    },
    handler: async (args, { client }) =>
      client.getPayloadFieldRefs(args.entryId as string, args.namespace as string),
  },
  {
    name: "citizen_get_payload_by_data_hash",
    description: "Look up a payload commitment by its data hash (SHA-256).",
    inputSchema: {
      type: "object",
      properties: { dataHash: { type: "string", description: "SHA-256 hash of the payload data" } },
      required: ["dataHash"],
    },
    handler: async (args, { client }) => client.getPayloadByDataHash(args.dataHash as string),
  },
];
