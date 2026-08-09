export interface ResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  content: () => string;
}

export const resources: ResourceDefinition[] = [
  {
    uri: "citizen://protocol/types",
    name: "Protocol Type Schemas",
    description: "Complete reference for all Citizen Protocol data types: LedgerEntry, SignedEnvelope, DeterministicReceipt, ConsentReceipt, NamespaceRuleset, and all related structs.",
    mimeType: "text/markdown",
    content: () => PROTOCOL_TYPES,
  },
  {
    uri: "citizen://protocol/policies",
    name: "Namespace Validation Policies",
    description: "Reference for all 21 namespace validation policies with their names, descriptions, and config schemas.",
    mimeType: "text/markdown",
    content: () => NAMESPACE_POLICIES,
  },
  {
    uri: "citizen://protocol/api-reference",
    name: "API Endpoint Reference",
    description: "Complete list of all HTTP endpoints exposed by a Citizen node, grouped by category with methods, paths, and descriptions.",
    mimeType: "text/markdown",
    content: () => API_REFERENCE,
  },
  {
    uri: "citizen://sdk/methods",
    name: "TypeScript SDK Methods",
    description: "All methods available on the @citizen-protocol/typescript-sdk CitizenNodeClient, EntryRecord builders, and multisig helpers.",
    mimeType: "text/markdown",
    content: () => SDK_METHODS,
  },
  {
    uri: "citizen://examples/submit-entry",
    name: "Example: Submit a Signed Entry",
    description: "Complete code example showing how to build, sign, and submit a ledger entry using the TypeScript SDK.",
    mimeType: "text/typescript",
    content: () => EXAMPLE_SUBMIT_ENTRY,
  },
  {
    uri: "citizen://examples/multisig",
    name: "Example: Multisig Transaction",
    description: "Complete code example for building a multisig transaction with threshold signatures.",
    mimeType: "text/typescript",
    content: () => EXAMPLE_MULTISIG,
  },
  {
    uri: "citizen://examples/create-namespace",
    name: "Example: Create a Namespace",
    description: "How to define and activate a namespace with validation policies via governance.",
    mimeType: "text/markdown",
    content: () => EXAMPLE_CREATE_NAMESPACE,
  },
  {
    uri: "citizen://examples/encrypted-entry",
    name: "Example: Privacy-Aware Encrypted Entry",
    description: "How to submit an entry with encrypted payload, consent receipt, and per-field reader ACLs.",
    mimeType: "text/markdown",
    content: () => EXAMPLE_ENCRYPTED_ENTRY,
  },
  {
    uri: "citizen://examples/civic-voting",
    name: "Example: Civic Voting dApp",
    description: "Architecture and code patterns for building a civic voting application on Citizen Protocol.",
    mimeType: "text/markdown",
    content: () => EXAMPLE_CIVIC_VOTING,
  },
  {
    uri: "citizen://examples/builder-credits",
    name: "Example: Builder Credits dApp",
    description: "How to use the builder.credits namespace for sponsored, non-speculative application usage.",
    mimeType: "text/markdown",
    content: () => EXAMPLE_BUILDER_CREDITS,
  },
];

const PROTOCOL_TYPES = `# Citizen Protocol Type Schemas

## Core Types

### LedgerEntry
The fundamental record on the Citizen ledger.

\`\`\`
{
  entry_id: UUID
  namespace: string
  action: string
  object_id: string
  payload: JSON object
  privacy_flag: boolean
  privacy_mode: "None" | "Passphrase" | "Hybrid"
  payload_commitment: string?       // SHA-256 of plaintext payload
  ciphertext_hex: string?           // AES-256-GCM ciphertext
  nonce_hex: string?                // GCM nonce
  salt_hex: string?                 // Argon2 salt
  kdf_params: KdfParams?            // Argon2 memory/iterations/parallelism
  consent_receipt: ConsentReceipt?  // Data-subject consent
  authorized_readers: string[]      // DIDs allowed to decrypt
  custodian_policy_id: string?
  field_reader_acls: Map<string, string[]>  // per-field reader lists
  key_wrapped_secrets: KeyWrap[]    // per-reader wrapped DEKs
  revocation_events: RevocationEvent[]
  author: string                    // DID of author
  signature: string                 // Ed25519 hex signature
  timestamp: i64                    // Unix epoch seconds
}
\`\`\`

### SignedEnvelope<T>
Canonical submission wrapper. Wraps a LedgerEntry with signer identity and optional multisig.

\`\`\`
{
  envelope_id: UUID
  signer: string                    // Primary signer DID
  signature: string                 // Ed25519 hex signature
  signature_scope: string?          // Replay protection scope tag
  co_signatures: [{ signer: string, signature: string }]
  multisig_policy: {
    threshold: u16
    allowed_signers: string[]
    require_author_signature: bool
  }?
  submitted_at: ISO 8601 datetime
  payload: T                        // Typically LedgerEntry
}
\`\`\`

### DeterministicReceipt
Proof that a transaction was validated and finalized.

\`\`\`
{
  receipt_id: UUID
  envelope_id: UUID
  status: "Accepted" | "Rejected"
  validation: {
    namespace: string
    action: string
    outcome: string
    offchain_commitments: {
      payload_commitment: string
      manifest_id: string?
      ciphertext_hash: string?
      encrypted_field_commitments: [{ field_path: string, payload_commitment: string }]
    }?
    multisig: { signature_scope: string, threshold: u16, signers: string[] }?
  }
  finality: {
    block_height: u64
    block_hash: string
    commit_proof: string            // Aggregated BLS signature
  }?
  recorded_at: ISO 8601 datetime
}
\`\`\`

### ConsentReceipt
Data-subject consent record for privacy-aware entries.

\`\`\`
{
  subject_did: string
  data_hash: string                 // SHA-256 of consented data
  policy_ref: string                // Policy identifier
  granted_at: i64
  expires_at: i64
  authorized_readers: string[]
  custodian_policy_id: string?
  field_reader_acls: Map<string, string[]>
}
\`\`\`

### NamespaceRuleset
Defines the rules for a namespace.

\`\`\`
{
  descriptor: {
    namespace: string
    version: string
    rules_hash: string
    governed_by: string
  }
  writers: Set<string>              // DIDs allowed to write
  validators: [{ name: string, config: JSON }]
}
\`\`\`

### Block & BlockHeader

\`\`\`
BlockHeader {
  height: u64
  prev_hash: string
  entry_root: string                // Merkle root of entries
  proposer: string                  // Validator ID
  timestamp: i64
  commit_proof: {
    aggregated_signature: string
    participant_ids: Set<string>
  }
}

Block {
  header: BlockHeader
  entries: Vec<LedgerEntry>
}
\`\`\`

### Governance Types

\`\`\`
GovernanceAction =
  | AddValidator { candidate_id, public_key, anchors, submitted_at }
  | RemoveValidator { validator_id, reason, evidence_hash, submitted_at }
  | UpdateNamespace { namespace descriptor }
  | Emergency { action, reason, submitted_at, expires_at }
  | UpdateParameter { key, value }

VoteChoice = "Yes" | "No" | "Abstain"
\`\`\`

### Privacy Types

\`\`\`
KeyWrap {
  reader_id: string
  wrapped_dek: string               // DEK encrypted for this reader
  wrap_algorithm: string            // e.g. "x25519-aes256gcm"
}

KdfParams {
  memory_kib: u32                   // Argon2 memory cost
  iterations: u32
  parallelism: u32
  output_length: u32
}

RevocationEvent {
  event_id: UUID
  data_hash: string
  reader_id: string
  timestamp: i64
  threshold_signatures: string[]
}
\`\`\`
`;

const NAMESPACE_POLICIES = `# Namespace Validation Policies

These are the 21 policies available for namespace rulesets. Each policy takes an optional JSON config.

## Core Policies

### require_signature
Ensures the entry has a valid Ed25519 signature from the author.
- **Config**: none
- **Use**: Every namespace should include this as a baseline.

### allowed_actions
Restricts which action verbs are permitted in the namespace.
- **Config**: \`{ "actions": ["CREATE", "TRANSFER", "UPDATE"] }\`

### require_payload_fields
Ensures specific fields exist in the entry payload.
- **Config**: \`{ "fields": ["asset_id", "amount", "owner"] }\`

### unique_by_field
Ensures no two entries in the namespace have the same value for a specific field (prevents duplicates).
- **Config**: \`{ "field": "asset_id" }\`

### prevent_double_transfer
Alias for \`unique_by_field\` with \`object_id\` forced as the unique field. Prevents the same asset from being transferred twice.
- **Config**: none

### author_matches_object_id
Ensures the entry author matches the object_id field (useful for self-attested records).
- **Config**: none

## Privacy & Consent Policies

### consent_policy
Validates that entries with privacy_flag=true include a valid ConsentReceipt.
- **Config**: \`{ "require_expiry": true, "min_ttl_secs": 3600 }\`

### privacy_policy
Enforces encryption requirements: checks ciphertext, nonce, salt, and KDF params are present when privacy_flag is true.
- **Config**: \`{ "require_kdf": true, "min_memory_kib": 65536 }\`

## Economic Policies

### builder_credit_policy
Validates builder credit operations (grants, sponsorships). Checks multisig proofs for credit grants and tracks sponsorship usage.
- **Config**: \`{ "require_multisig": true, "min_approvers": 2 }\`

### asset_control_policy
Enforces asset ownership: only the current owner can transfer an asset. Tracks asset positions per account.
- **Config**: \`{ "transfer_action": "TRANSFER", "owner_field": "owner_did" }\`

## Execution Policies

### wasm_runtime_policy
Validates WASM module execution: checks module hash, gas limits, and capability permissions.
- **Config**: \`{ "max_gas": 1000000, "allowed_capabilities": ["storage_read", "storage_write"] }\`

### envelope_multisig_policy
Enforces multisig requirements on submitted envelopes. Checks threshold, allowed signers, and author signature requirements.
- **Config**: \`{ "min_threshold": 2 }\`

## Civic & Governance Policies

### ctzn_citizenship_policy
Validates CTZN citizenship token requirements (holder must be a verified citizen).
- **Config**: \`{ "module_id": "ctzn-citizenship-v1" }\`

### civic_voting_policy
Validates civic proposal submissions and votes. Checks proposal format, voting period, and eligibility.
- **Config**: \`{ "min_voting_period_secs": 86400 }\`

### election_ballot_policy
Validates election ballots: checks voter eligibility, prevents double voting, verifies ballot format.
- **Config**: \`{ "require_kyc": true }\`

### election_race_policy
Validates election race definitions: candidate list, race configuration, eligibility rules.
- **Config**: \`{ "max_candidates": 20 }\`

### kyc_verification_policy
Enforces KYC verification: entries must come from KYC-verified DIDs.
- **Config**: \`{ "kyc_authority_did": "did:web:gov.example:kyc" }\`

### admin_assignment_policy
Validates admin role assignments. Only existing admins can assign new admins.
- **Config**: \`{ "admin_namespace": "gov.civic" }\`

### civic_admin_gate
Gates civic operations behind admin verification. Only civic admins can perform gated actions.
- **Config**: \`{ "admin_only_actions": ["CREATE_PROPOSAL", "OPEN_ELECTION"] }\`

### voter_registration_policy
Validates voter registration entries. Checks jurisdiction, eligibility, and prevents duplicate registrations.
- **Config**: \`{ "jurisdiction_field": "jurisdiction_id" }\`

### voter_jurisdiction_policy
Ensures voters can only vote in elections within their registered jurisdiction.
- **Config**: \`{ "jurisdiction_match_required": true }\`

## Composing Policies

Namespaces combine multiple policies. Example for a civic voting namespace:

\`\`\`json
{
  "namespace": "gov.civic",
  "validators": [
    { "name": "require_signature" },
    { "name": "allowed_actions", "config": { "actions": ["CREATE_PROPOSAL", "CAST_VOTE", "OPEN_ELECTION"] } },
    { "name": "civic_voting_policy" },
    { "name": "voter_registration_policy", "config": { "jurisdiction_field": "district" } },
    { "name": "voter_jurisdiction_policy" },
    { "name": "kyc_verification_policy" }
  ]
}
\`\`\`
`;

const API_REFERENCE = `# Citizen Protocol API Reference

Base URL: \`http://<node-host>:<api-port>\` (default port: 7001)

## Health
| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Node health check |

## Blocks
| Method | Path | Description |
|--------|------|-------------|
| GET | /blocks | List blocks (query: limit, cursor) |
| GET | /blocks/:height | Get block by height |

## Namespaces & Entries
| Method | Path | Description |
|--------|------|-------------|
| GET | /namespaces | List all namespaces |
| GET | /entries/:namespace | List entries in a namespace |

## Identity
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/v1/identity/:did | Resolve DID document |
| GET | /api/v1/identity/kyc/:did | Get KYC status for DID |
| GET | /api/v1/identity/kyc | List all KYC records |

## Consent
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/v1/consent/check | Validate a ConsentReceipt |

## Entry Submission
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/v1/entries/submit | Submit raw LedgerEntry (legacy) |
| POST | /api/v1/envelopes/submit | Submit SignedEnvelope (canonical) |
| POST | /api/v1/envelopes/submit-batch | Submit batch of envelopes |

## Receipts
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/v1/receipts/:receipt_id | Get receipt by UUID |

## Builder Credits
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/v1/builder-credits/:builder_id | Get builder credit balance |

## Assets
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/v1/assets/:account_id | Get asset positions |

## Modules (WASM)
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/v1/modules/:module_id | Get module runtime state |
| POST | /api/v1/modules/:module_id/execute | Execute module |

## Interop
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/v1/interop/:object_id | Get cross-chain interop status |

## Governance
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/v1/governance/proposals | List governance proposals |

## Civic
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/v1/civic/proposals | List civic proposals |
| GET | /api/v1/civic/proposals/:proposal_id | Get civic proposal |
| GET | /api/v1/civic/proposals/:proposal_id/tally | Get proposal tally |
| GET | /api/v1/civic/elections | List elections |
| GET | /api/v1/civic/elections/:election_id | Get election |
| GET | /api/v1/civic/elections/:election_id/tally | Get election tally |
| GET | /api/v1/civic/elections/:election_id/ballots | List ballots |
| GET | /api/v1/civic/admin/check/:did | Check civic admin |
| GET | /api/v1/civic/admin/kyc-public-key | Get KYC public key |
| GET | /api/v1/civic/registry/:did | Check civic registry |
| GET | /api/v1/civic/elections/:election_id/eligibility/:did | Check voter eligibility |

## CTZN Tokens
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/v1/ctzn/:module_id/status | Token module status |
| GET | /api/v1/ctzn/:module_id/holders | List holders |
| GET | /api/v1/ctzn/:module_id/check/:did | Check balance |

## Off-Chain Encrypted Files
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/v1/files/intents | Create upload intent |
| POST | /api/v1/files/commit | Commit uploaded file |
| POST | /api/v1/files/read | Read file (privacy-gated) |
| POST | /api/v1/files/revoke | Revoke reader access |
| GET | /api/v1/files/manifests/:manifest_id | Get manifest metadata |
| GET | /api/v1/files/alerts | List access alerts |

## Payload Commitments
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/v1/payloads/commit | Commit encrypted payload refs |
| GET | /api/v1/payloads/fields/:entry_id/:namespace | Get field refs |
| GET | /api/v1/payloads/data-hash/:data_hash | Lookup by data hash |
| GET | /data-hash | Lookup by data hash (query param) |
`;

const SDK_METHODS = `# TypeScript SDK Methods (@citizen-protocol/typescript-sdk)

## CitizenNodeClient

### Constructor
\`\`\`ts
new CitizenNodeClient({ baseUrl, apiKey?, fetchImpl? })
\`\`\`

### Transaction Methods
| Method | Description |
|--------|-------------|
| \`submitTransaction({ namespace, action, objectId, payload?, signer, timestamp? })\` | Full lifecycle: build, sign, wrap, submit |
| \`submitWithBrowserWallet({ namespace, action, objectId, payload?, walletProvider?, account?, requestMethod? })\` | Submit via browser wallet (EIP-1193) |
| \`submitEnvelope(envelope)\` | Submit a pre-built SignedEnvelope |
| \`submitEnvelopeBatch(envelopes)\` | Submit batch of envelopes |

### Signing Methods
| Method | Description |
|--------|-------------|
| \`signEntry(entry, signer)\` | Sign a LedgerEntry |
| \`wrapEnvelope({ entry, signer, submittedAt? })\` | Wrap signed entry into envelope |
| \`wrapEnvelopeMulti(args)\` | Build multisig envelope |
| \`appendCoSignature(args)\` | Add co-signature to envelope |
| \`finalizeEnvelope(args)\` | Validate envelope meets multisig policy |

### Query Methods
| Method | Description |
|--------|-------------|
| \`getReceipt(receiptId)\` | Get receipt by ID |
| \`waitForReceipt(receiptId, options?)\` | Poll until receipt is terminal |

## Entry Builders

### createFormCommitmentReceipt({ formId, dataHash, encryptedFormUrl, commitmentReceipt? })
Returns \`{ namespace: "forms.commitment", action, objectId, payload }\`

### createMultisigCreditGrant({ builderId, amount, multisigProofs })
Returns \`{ namespace: "builder.credits", action: "MULTISIG_CREDIT_GRANT", objectId, payload }\`

### createSponsorshipUsage({ builderId, amount, creditGrantId, sponsorshipId, sponsoredDid })
Returns \`{ namespace: "builder.credits", action: "SPONSOR_USAGE", objectId, payload }\`

### validateBuilderCreditsPayload({ action, payload })
Validates builder credit payloads. Throws on invalid.

## Signers

### Ed25519Signer
\`\`\`ts
new Ed25519Signer(privateKeyHex)
// Implements: getSignerId() -> Promise<string>, sign(message) -> Promise<string>
\`\`\`

### BrowserWalletSigner
Uses an EIP-1193 provider to sign Citizen payloads via browser wallet.

## Utility Functions
| Function | Description |
|--------|-------------|
| \`canonicalizeJson(value)\` | Canonical JSON serialization (sorted keys, no whitespace) |
| \`sha256DigestHex(data)\` | SHA-256 hex digest |
| \`signCitizenPayloadWithWallet({ payload, provider? })\` | Sign payload with browser wallet |
`;

const EXAMPLE_SUBMIT_ENTRY = `// Example: Submit a signed entry to Citizen Protocol
import { CitizenNodeClient, Ed25519Signer } from "@citizen-protocol/typescript-sdk";

const client = new CitizenNodeClient({
  baseUrl: "http://localhost:7001",
});

// 1. Generate or load a signer
const signer = new Ed25519Signer(process.env.PRIVATE_KEY_HEX!);
const signerId = await signer.getSignerId();

// 2. Submit a transaction (build + sign + wrap + submit)
const result = await client.submitTransaction({
  namespace: "asset.registry",
  action: "CREATE",
  objectId: "asset-001",
  payload: {
    name: "City Park Title",
    owner_did: signerId,
    metadata: { lat: 35.6762, lon: 139.6503 },
  },
  signer,
});

console.log("Submitted:", result);

// 3. Wait for receipt (polls until finalized)
const receiptId = (result as { receipt_id?: string }).receipt_id;
if (receiptId) {
  const receipt = await client.waitForReceipt(receiptId, {
    pollIntervalMs: 1000,
    timeoutMs: 30000,
  });
  console.log("Finalized:", receipt);
}
`;

const EXAMPLE_MULTISIG = `// Example: Multisig transaction with threshold signatures
import { CitizenNodeClient, Ed25519Signer, wrapEnvelopeMulti, appendCoSignature } from "@citizen-protocol/typescript-sdk";

const client = new CitizenNodeClient({ baseUrl: "http://localhost:7001" });

// Signers (3-of-5 multisig)
const primarySigner = new Ed25519Signer(process.env.PRIVATE_KEY_A!);
const coSignerB = new Ed25519Signer(process.env.PRIVATE_KEY_B!);
const coSignerC = new Ed25519Signer(process.env.PRIVATE_KEY_C!);

// 1. Build the entry
const entry = {
  entry_id: crypto.randomUUID(),
  namespace: "treasury.multisig",
  action: "TRANSFER",
  object_id: "tx-001",
  payload: { amount: 1000, to: "did:web:example.com:recipient" },
  author: await primarySigner.getSignerId(),
  timestamp: Math.floor(Date.now() / 1000),
};

// 2. Wrap into multisig envelope (3-of-5)
const envelope = await wrapEnvelopeMulti({
  entry,
  signer: primarySigner,
  coSigners: [coSignerB, coSignerC],
  multisigPolicy: {
    threshold: 3,
    allowed_signers: [
      "did:web:example.com:signer-a",
      "did:web:example.com:signer-b",
      "did:web:example.com:signer-c",
      "did:web:example.com:signer-d",
      "did:web:example.com:signer-e",
    ],
    require_author_signature: true,
  },
  signatureScope: "treasury-v1",
});

// 3. Submit
const result = await client.submitEnvelope(envelope);
console.log("Multisig submitted:", result);
`;

const EXAMPLE_CREATE_NAMESPACE = `# Creating a Namespace on Citizen Protocol

Namespaces are the core governance primitive. Each namespace has its own writers, validation policies, and governance scope.

## Step 1: Design the Ruleset

Identify which of the 21 validation policies you need. See \`citizen://protocol/policies\` for the full reference.

## Step 2: Submit a Governance Proposal

Namespace activation requires a governance proposal with an \`UpdateNamespace\` action:

\`\`\`json
{
  "namespace": "myapp.records",
  "version": "1.0.0",
  "rules_hash": "0x...",
  "governed_by": "community",
  "writers": ["did:web:myapp.com:admin"],
  "validators": [
    { "name": "require_signature" },
    { "name": "allowed_actions", "config": { "actions": ["CREATE", "UPDATE"] } },
    { "name": "require_payload_fields", "config": { "fields": ["record_id", "data_hash"] } }
  ]
}
\`\`\`

## Step 3: Submit via Envelope

Wrap the governance proposal in a SignedEnvelope and submit it. The governance engine will evaluate quorum.

## Step 4: Wait for Activation

Once the proposal passes quorum, the namespace becomes active and entries can be submitted to it.

## Using the MCP Builder Tool

\`\`\`
Use citizen_build_namespace_ruleset with:
  namespace: "myapp.records"
  governed_by: "community"
  writers: ["did:web:myapp.com:admin"]
  rules:
    - name: require_signature
    - name: allowed_actions, config: { actions: ["CREATE", "UPDATE"] }
    - name: require_payload_fields, config: { fields: ["record_id", "data_hash"] }
\`\`\`
`;

const EXAMPLE_ENCRYPTED_ENTRY = `# Privacy-Aware Encrypted Entry

Citizen Protocol supports encrypted entries where the payload is encrypted client-side and only the commitment is recorded on-chain.

## Architecture

1. **Client encrypts** the payload using AES-256-GCM with a random DEK (Data Encryption Key)
2. **DEK is wrapped** per-authorized-reader using X25519 key exchange
3. **Commitment** (SHA-256 of plaintext) is stored on-chain
4. **Consent receipt** proves data-subject consent
5. **Off-chain storage** holds the ciphertext (optional, for large payloads)

## Entry Structure

\`\`\`json
{
  "namespace": "health.records",
  "action": "CREATE",
  "object_id": "record-001",
  "payload": {},  // empty or minimal metadata only
  "privacy_flag": true,
  "privacy_mode": "Hybrid",
  "payload_commitment": "sha256-of-plaintext",
  "ciphertext_hex": "...",
  "nonce_hex": "...",
  "salt_hex": "...",
  "kdf_params": { "memory_kib": 65536, "iterations": 3, "parallelism": 1, "output_length": 32 },
  "consent_receipt": {
    "subject_did": "did:web:patient.example",
    "data_hash": "sha256-of-data",
    "policy_ref": "hipaa-consent-v1",
    "granted_at": 1723000000,
    "expires_at": 1754536000,
    "authorized_readers": ["did:web:doctor.example"],
    "field_reader_acls": {
      "diagnosis": ["did:web:doctor.example"],
      "insurance": ["did:web:billing.example"]
    }
  },
  "authorized_readers": ["did:web:doctor.example"],
  "key_wrapped_secrets": [
    {
      "reader_id": "did:web:doctor.example",
      "wrapped_dek": "...",
      "wrap_algorithm": "x25519-aes256gcm"
    }
  ]
}
\`\`\`

## Required Namespace Policies

\`\`\`json
[
  { "name": "require_signature" },
  { "name": "consent_policy", "config": { "require_expiry": true } },
  { "name": "privacy_policy", "config": { "require_kdf": true } }
]
\`\`\`
`;

const EXAMPLE_CIVIC_VOTING = `# Civic Voting dApp on Citizen Protocol

Citizen Protocol has first-class civic voting support with election/ballot/tally primitives.

## Architecture Overview

\`\`\`
┌─────────────┐     ┌──────────────────┐     ┌──────────────┐
│  Voter App   │────▶│  Citizen Node    │────▶│  Tally API   │
│  (Flutter)   │     │  (civic engine)  │     │  (real-time) │
└─────────────┘     └──────────────────┘     └──────────────┘
                            │
                     ┌──────────────┐
                     │  KYC Verify   │
                     │  (on-chain)   │
                     └──────────────┘
\`\`\`

## Key Namespaces

| Namespace | Purpose |
|-----------|---------|
| \`gov.civic\` | Civic proposals, elections, admin |
| \`gov.identity\` | KYC, DID registration |
| \`ctzn.citizenship\` | Citizenship token (eligibility gate) |

## Workflow

### 1. Register Voters
Submit a voter registration entry to \`gov.civic\` with \`voter_registration_policy\`.

### 2. Create Election
Civic admin creates an election with candidate list via \`election_race_policy\`.

### 3. Cast Ballots
Voters submit encrypted ballots with \`election_ballot_policy\` (requires KYC).

### 4. Tally Results
Use the election tally endpoint: \`GET /api/v1/civic/elections/:id/tally\`

## MCP Tool Usage

\`\`\`
citizen_list_civic_elections       → See active elections
citizen_check_voter_eligibility    → Verify voter can participate
citizen_submit_envelope            → Submit a ballot
citizen_get_election_tally         → Get live results
\`\`\`
`;

const EXAMPLE_BUILDER_CREDITS = `# Builder Credits dApp Pattern

Builder credits enable non-speculative, sponsored application usage on Citizen Protocol.

## How It Works

1. **Sponsors** fund builder credit grants (via multisig approval)
2. **Builders** spend credits for sponsored transactions
3. **No token speculation** — credits are usage units, not tradeable assets

## Namespaces

| Namespace | Purpose |
|-----------|---------|
| \`builder.credits\` | Credit grants, sponsorship usage |

## Actions

| Action | Description |
|--------|-------------|
| \`MULTISIG_CREDIT_GRANT\` | Grant credits to a builder (requires multisig approval) |
| \`SPONSOR_USAGE\` | Record sponsored transaction usage |

## Example: Grant Credits

Use \`citizen_build_entry\`:
\`\`\`
namespace: builder.credits
action: MULTISIG_CREDIT_GRANT
object_id: <builder_did>
payload:
  amount: 1000
  multisig_proofs:
    - approver: did:web:sponsor-a
      public_key: ed25519:...
      signature: ...
    - approver: did:web:sponsor-b
      public_key: ed25519:...
      signature: ...
\`\`\`

## Example: Record Sponsorship Usage

\`\`\`
namespace: builder.credits
action: SPONSOR_USAGE
object_id: <builder_did>
payload:
  amount: 10
  credit_grant_id: grant-001
  sponsorship_id: sponsor-001
  sponsored_did: did:web:user.example
\`\`\`

## SDK Helpers

\`\`\`ts
import { createMultisigCreditGrant, createSponsorshipUsage, validateBuilderCreditsPayload } from "@citizen-protocol/typescript-sdk";

const grant = createMultisigCreditGrant({ builderId, amount: 1000, multisigProofs });
validateBuilderCreditsPayload({ action: "MULTISIG_CREDIT_GRANT", payload: grant.payload });

const usage = createSponsorshipUsage({ builderId, amount: 10, creditGrantId, sponsorshipId, sponsoredDid });
validateBuilderCreditsPayload({ action: "SPONSOR_USAGE", payload: usage.payload });
\`\`\`
`;
