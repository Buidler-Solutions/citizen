# MCP Server for dApp Development

The Citizen Protocol MCP Server (`@citizen-protocol/mcp-server`) is a Model Context Protocol server that lets AI assistants, IDE extensions, and developer tools interact with Citizen nodes, build dApp components, and access protocol reference data — without leaving the conversation or code editor.

Instead of switching between documentation, API references, terminal windows, and code editors, a developer can ask an AI assistant connected to this MCP server to query the ledger, build entries, sign transactions, design namespaces, and submit envelopes — all through natural language.

---

## How MCP Works with Citizen

The MCP server sits between your AI client and a Citizen node:

```
Developer (natural language)
    │
    ▼
┌──────────────┐        ┌──────────────────────┐        ┌──────────────┐
│  AI Client   │◄──────►│  Citizen MCP Server  │◄──────►│  Citizen Node│
│  (Claude,    │  MCP   │                      │  HTTP  │  (API +      │
│   VS Code,   │ stdio  │  49 tools            │  /api  │   consensus) │
│   Cursor)    │        │  10 resources        │        │              │
└──────────────┘        │  8 prompts           │        └──────────────┘
                        └──────────────────────┘
```

**Key idea:** The MCP server exposes three types of capabilities:

| Capability | Count | Purpose |
|---|---|---|
| **Tools** | 49 | Functions the AI can call (query ledger, submit txns, build entries) |
| **Resources** | 10 | Reference documents (type schemas, policies, examples) |
| **Prompts** | 8 | Guided workflows (create a dApp, set up multisig, etc.) |

The server uses the **stdio transport** — it communicates over standard input/output, making it compatible with any MCP-compliant client.

---

## Installation

### Prerequisites

- Node.js 18+ (Node 20+ recommended)
- A running Citizen node (or use the server in builder-only mode without one)

### Build from Source

```bash
cd sdk/mcp-server
npm install
npm run build
```

This produces `dist/index.js` — the entry point for the MCP server.

### Verify the Build

```bash
# Should start and print a connection message
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}' | \
  CITIZEN_NODE_URL=http://localhost:7001 node dist/index.js
```

---

## Configuration

The server reads two environment variables:

| Variable | Default | Description |
|---|---|---|
| `CITIZEN_NODE_URL` | `http://localhost:7001` | URL of the Citizen node API |
| `CITIZEN_API_KEY` | _(none)_ | Optional API key for authenticated nodes |

### Connecting to Different Networks

```bash
# Local development node
CITIZEN_NODE_URL=http://localhost:7001 node dist/index.js

# Remote node with API key
CITIZEN_NODE_URL=https://node.example.com CITIZEN_API_KEY=secret123 node dist/index.js

# Builder-only mode (no node required — tools that need a node will error gracefully)
CITIZEN_NODE_URL=http://localhost:9999 node dist/index.js
```

---

## Client Integration

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "citizen-protocol": {
      "command": "node",
      "args": ["/absolute/path/to/sdk/mcp-server/dist/index.js"],
      "env": {
        "CITIZEN_NODE_URL": "http://localhost:7001"
      }
    }
  }
}
```

Restart Claude Desktop. The Citizen tools will appear in the tool palette.

### VS Code (with MCP Extension)

Add to `.vscode/mcp.json` or your VS Code settings:

```json
{
  "mcp.servers": {
    "citizen-protocol": {
      "command": "node",
      "args": ["/absolute/path/to/sdk/mcp-server/dist/index.js"],
      "env": {
        "CITIZEN_NODE_URL": "http://localhost:7001"
      }
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "citizen-protocol": {
      "command": "node",
      "args": ["/absolute/path/to/sdk/mcp-server/dist/index.js"],
      "env": {
        "CITIZEN_NODE_URL": "http://localhost:7001"
      }
    }
  }
}
```

### OpenCode

OpenCode uses a JSON config file at `~/.config/opencode/opencode.json` (global) or `opencode.json` in your project root:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "citizen-protocol": {
      "type": "local",
      "command": ["node", "/absolute/path/to/sdk/mcp-server/dist/index.js"],
      "enabled": true,
      "environment": {
        "CITIZEN_NODE_URL": "http://localhost:7001"
      }
    }
  }
}
```

Restart OpenCode. The Citizen tools will be available to the AI agent.

### Secretaria (Crush)

Secretaria reads `crush.json` from the project root (or `~/.config/crush/crush.json` globally). Add the Citizen server under the `mcp` key:

```json
{
  "mcp": {
    "citizen-protocol": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/sdk/mcp-server/dist/index.js"],
      "env": {
        "CITIZEN_NODE_URL": "http://localhost:7001"
      }
    }
  }
}
```

Restart Secretaria. The 49 Citizen tools, 10 resources, and 8 prompts will be loaded automatically. Verify with `/mcp` or check the startup log for `citizen-protocol = connected`.

### Any MCP Client

The server implements the standard MCP protocol over stdio. Any client that supports MCP 1.0+ can connect.

---

## Tools Reference

The server exposes **49 tools** across three categories.

### Query Tools (32) — Read-Only Ledger Access

These tools map 1:1 to the Citizen node's HTTP GET endpoints. They are safe to call anytime — they never modify ledger state.

#### Node & Blocks

| Tool | Parameters | Description |
|---|---|---|
| `citizen_health` | _(none)_ | Check if the node is online. Returns `{"status":"ok"}`. |
| `citizen_list_blocks` | `limit?`, `cursor?` | List recent blocks with headers. |
| `citizen_get_block` | `height` | Get a single block by height, including all entries. |

#### Namespaces & Entries

| Tool | Parameters | Description |
|---|---|---|
| `citizen_list_namespaces` | _(none)_ | List all active namespaces. |
| `citizen_list_entries` | `namespace`, `limit?`, `cursor?` | List entries within a namespace. |
| `citizen_get_receipt` | `receiptId` | Get a receipt by UUID (validation + finality proof). |

#### Identity

| Tool | Parameters | Description |
|---|---|---|
| `citizen_resolve_did` | `did` | Resolve a DID to its document. |
| `citizen_get_kyc_status` | `did` | Check KYC verification status. |
| `citizen_list_kyc` | _(none)_ | List all KYC records. |

#### Governance & Civic

| Tool | Parameters | Description |
|---|---|---|
| `citizen_get_governance_proposals` | _(none)_ | List all governance proposals. |
| `citizen_list_civic_proposals` | _(none)_ | List civic proposals (ballot measures). |
| `citizen_get_civic_proposal` | `proposalId` | Get a single civic proposal. |
| `citizen_get_civic_tally` | `proposalId` | Get vote tally for a proposal. |
| `citizen_list_civic_elections` | _(none)_ | List civic elections. |
| `citizen_get_civic_election` | `electionId` | Get a single election. |
| `citizen_get_election_tally` | `electionId` | Get vote tally for an election. |
| `citizen_get_election_ballots` | `electionId` | List submitted ballots. |
| `citizen_check_civic_admin` | `did` | Check if a DID is a civic admin. |
| `citizen_get_civic_kyc_public_key` | _(none)_ | Get the KYC public key. |
| `citizen_check_civic_registry` | `did` | Check civic registry status. |
| `citizen_check_voter_eligibility` | `electionId`, `did` | Check if a DID can vote in an election. |

#### Tokens & Economics

| Tool | Parameters | Description |
|---|---|---|
| `citizen_get_ctzn_status` | `moduleId` | Get CTZN token module status. |
| `citizen_get_ctzn_holders` | `moduleId` | List token holders. |
| `citizen_get_ctzn_balance` | `moduleId`, `did` | Check token balance for a DID. |
| `citizen_get_builder_credits` | `builderId` | Get builder credit balance. |
| `citizen_get_asset_positions` | `accountId` | Get asset positions for an account. |

#### Modules & Interop

| Tool | Parameters | Description |
|---|---|---|
| `citizen_get_module_runtime` | `moduleId` | Get WASM module runtime state. |
| `citizen_get_interop_status` | `objectId` | Get cross-chain interop status. |

#### Off-Chain Files & Payloads

| Tool | Parameters | Description |
|---|---|---|
| `citizen_get_file_manifest` | `manifestId` | Get file manifest metadata. |
| `citizen_list_file_alerts` | _(none)_ | List file access alerts. |
| `citizen_get_payload_field_refs` | `entryId`, `namespace` | Get payload field commitments. |
| `citizen_get_payload_by_data_hash` | `dataHash` | Look up payload by SHA-256 hash. |

### Action Tools (10) — Write Operations

These tools send data to the node. They modify ledger state (subject to validation and consensus).

| Tool | Parameters | Description |
|---|---|---|
| `citizen_submit_entry` | `entry` | Submit a raw LedgerEntry (legacy path). |
| `citizen_submit_envelope` | `envelope` | Submit a SignedEnvelope (canonical path). |
| `citizen_submit_envelope_batch` | `envelopes[]` | Submit a batch of envelopes. |
| `citizen_check_consent` | `consentReceipt` | Validate a ConsentReceipt. |
| `citizen_execute_module` | `moduleId`, `payload` | Execute a WASM module. |
| `citizen_create_file_intent` | `intent` | Create an upload intent for encrypted files. |
| `citizen_commit_file` | `commit` | Commit an uploaded file. |
| `citizen_read_file` | `readRequest` | Read an encrypted file (privacy-gated). |
| `citizen_revoke_file_reader` | `revokeRequest` | Revoke a reader's file access. |
| `citizen_commit_payload` | `commit` | Commit encrypted payload field references. |

### Builder Tools (7) — Client-Side Construction

These tools run locally on the MCP server — they do not require a running node. They help developers construct valid protocol structures.

| Tool | Parameters | Description |
|---|---|---|
| `citizen_build_entry` | `namespace`, `action`, `object_id`, `payload`, `author`, `privacy_flag?` | Build a LedgerEntry with auto-generated UUID and timestamp. Returns an unsigned entry. |
| `citizen_build_envelope` | `entry`, `signer`, `signature`, `signature_scope?` | Wrap a signed entry into a SignedEnvelope. |
| `citizen_build_multisig_envelope` | `entry`, `primary_signer`, `primary_signature`, `threshold`, `allowed_signers?`, `require_author_signature?`, `signature_scope?` | Build a multisig threshold envelope. |
| `citizen_build_namespace_ruleset` | `namespace`, `rules[]`, `writers?`, `governed_by?`, `version?` | Design a complete namespace ruleset. |
| `citizen_validate_entry_structure` | `entry` | Validate an entry has all required fields. |
| `citizen_generate_keypair` | _(none)_ | Generate an Ed25519 keypair with suggested DID. |
| `citizen_sign_entry` | `entry`, `privateKeyHex` | Sign an entry with an Ed25519 private key. |

---

## Resources Reference

Resources are reference documents the AI can read on-demand. They provide the context the AI needs to give accurate guidance.

| URI | Description |
|---|---|
| `citizen://protocol/types` | Complete type schemas: LedgerEntry, SignedEnvelope, DeterministicReceipt, ConsentReceipt, NamespaceRuleset, and all related structs. |
| `citizen://protocol/policies` | All 21 namespace validation policies with names, descriptions, and config schemas. |
| `citizen://protocol/api-reference` | Complete HTTP endpoint reference — all 42 routes grouped by category. |
| `citizen://sdk/methods` | TypeScript SDK methods: CitizenNodeClient, builders, multisig helpers, signers. |
| `citizen://examples/submit-entry` | Code example: build, sign, and submit a ledger entry. |
| `citizen://examples/multisig` | Code example: multisig transaction with threshold signatures. |
| `citizen://examples/create-namespace` | Guide: namespace creation via governance. |
| `citizen://examples/encrypted-entry` | Guide: privacy-aware entries with encryption and consent. |
| `citizen://examples/civic-voting` | Guide: civic voting dApp architecture. |
| `citizen://examples/builder-credits` | Guide: builder credits for sponsored usage. |

---

## Prompts Reference

Prompts are pre-built conversation starters for common dApp development tasks. They provide structured guidance and automatically reference the right tools and resources.

| Prompt | Arguments | When to Use |
|---|---|---|
| `create-dapp` | `appName`, `description`, `features?` | Starting a new dApp from scratch. |
| `submit-transaction` | `namespace`, `action`, `payloadDescription?` | Submitting a specific transaction type. |
| `create-namespace` | `purpose`, `writers?`, `privacyNeeded?` | Designing a new namespace with policies. |
| `query-ledger` | `whatToFind` | Finding information on the ledger. |
| `setup-multisig` | `threshold`, `useCase?` | Setting up a multisig workflow. |
| `build-civic-app` | `appType`, `jurisdiction?` | Building civic engagement applications. |
| `deploy-wasm-module` | `moduleName`, `functionality` | Deploying WASM execution modules. |
| `privacy-design` | `dataType`, `readers?` | Designing privacy-aware entries. |

---

## Workflows

This section walks through complete dApp development workflows using the MCP server.

### Workflow 1: Explore an Existing Network

Before building, understand what's already on-chain.

```
You: "What namespaces exist on this network?"

AI: [calls citizen_list_namespaces]
    The network has 5 active namespaces:
    - gov.civic (governed by: system)
    - builder.credits (governed by: community)
    - forms.commitment (governed by: community)
    - asset.registry (governed by: community)
    - ctzn.citizenship (governed by: system)

You: "Show me the latest entries in gov.civic"

AI: [calls citizen_list_entries with namespace="gov.civic"]
    ...

You: "What governance proposals are active?"

AI: [calls citizen_get_governance_proposals]
    ...
```

### Workflow 2: Build and Submit a Transaction

The complete lifecycle: generate keys → build entry → sign → wrap envelope → submit → wait for receipt.

```
You: "I want to register an asset on the asset.registry namespace"

AI: [reads citizen://protocol/types to understand LedgerEntry structure]
    [reads citizen://protocol/policies to check required fields]
    [calls citizen_build_entry with:
      namespace: "asset.registry"
      action: "CREATE"
      object_id: "property-001"
      payload: { name: "...", location: {...} }
      author: "did:web:..." ]

    Here's your entry. You need to sign it before submitting.

    [calls citizen_generate_keypair]
    [calls citizen_sign_entry with the entry and private key]
    [calls citizen_build_envelope with the signed entry]
    [calls citizen_submit_envelope]
    [calls citizen_get_receipt to poll for finality]

    Transaction finalized at block height 42.
```

### Workflow 3: Design a Namespace

```
You: "I need a namespace for tracking government grants with audit trails"

AI: [reads citizen://protocol/policies]
    [calls citizen_build_namespace_ruleset with:
      namespace: "gov.grants"
      rules: [
        { name: "require_signature" },
        { name: "allowed_actions", config: { actions: ["CREATE", "DISBURSE", "AUDIT"] } },
        { name: "require_payload_fields", config: { fields: ["grant_id", "amount", "recipient_did"] } },
        { name: "consent_policy", config: { require_expiry: true } }
      ]
    ]

    Here's your namespace ruleset. To activate it, submit a governance
    proposal with an UpdateNamespace action...
```

### Workflow 4: Set Up Multisig

```
You: "Set up a 3-of-5 multisig for our treasury"

AI: [reads citizen://examples/multisig]
    [calls citizen_generate_keypair × 5 for each signer]
    [calls citizen_build_multisig_envelope with threshold=3]

    Primary signature included. Collect 2 more co-signatures
    via appendCoSignature before submitting...
```

### Workflow 5: Privacy-Aware Health Records

```
You: "I need to store encrypted patient records with per-field reader ACLs"

AI: [reads citizen://examples/encrypted-entry]
    [reads citizen://protocol/types for ConsentReceipt and KeyWrap schemas]
    [calls citizen_build_entry with privacy_flag=true]
    [calls citizen_build_namespace_ruleset with consent_policy and privacy_policy]

    Here's the complete entry structure with:
    - AES-256-GCM ciphertext
    - Argon2 KDF parameters
    - Per-field reader ACLs (diagnosis → doctor, insurance → billing)
    - Consent receipt with 1-year expiry
    ...
```

---

## The Full Transaction Lifecycle

When you submit a transaction via the MCP server, here's what happens under the hood:

```
1. citizen_build_entry          → Unsigned LedgerEntry (UUID, timestamp, structure)
2. citizen_generate_keypair     → Ed25519 keypair + DID  (one-time setup)
3. citizen_sign_entry           → Signed entry (Ed25519 signature over canonical JSON)
4. citizen_build_envelope       → SignedEnvelope wrapping the entry
5. citizen_submit_envelope      → HTTP POST to /api/v1/envelopes/submit
6. citizen_get_receipt (poll)   → DeterministicReceipt with FinalityProof
```

At step 6, the receipt contains:

```json
{
  "status": "Accepted",
  "validation": {
    "namespace": "asset.registry",
    "action": "CREATE",
    "outcome": "validated"
  },
  "finality": {
    "block_height": 42,
    "block_hash": "0x...",
    "commit_proof": "aggregated_bls_signature"
  }
}
```

Once `finality` is populated, the transaction is immutable. No reorgs, no ambiguity.

---

## Architecture Deep Dive

### Project Structure

```
sdk/mcp-server/
├── src/
│   ├── index.ts              # Entry point — reads env vars, starts stdio transport
│   ├── server.ts             # MCP server — registers tools/resources/prompts
│   ├── client.ts             # HTTP client wrapping all 42 Citizen node endpoints
│   ├── tools/
│   │   ├── query.ts          # 32 read-only query tools
│   │   ├── action.ts         # 10 write/submission tools
│   │   └── builder.ts        # 7 client-side construction tools
│   ├── resources/
│   │   └── index.ts          # 10 protocol reference resources
│   └── prompts/
│       └── index.ts          # 8 guided development prompts
├── package.json
├── tsconfig.json
└── README.md
```

### How Tools Map to the API

Every query and action tool maps directly to a Citizen node HTTP endpoint:

| MCP Tool | HTTP Method & Path |
|---|---|
| `citizen_health` | `GET /health` |
| `citizen_list_blocks` | `GET /blocks` |
| `citizen_get_block` | `GET /blocks/:height` |
| `citizen_list_namespaces` | `GET /namespaces` |
| `citizen_list_entries` | `GET /entries/:namespace` |
| `citizen_submit_entry` | `POST /api/v1/entries/submit` |
| `citizen_submit_envelope` | `POST /api/v1/envelopes/submit` |
| `citizen_submit_envelope_batch` | `POST /api/v1/envelopes/submit-batch` |
| `citizen_get_receipt` | `GET /api/v1/receipts/:receipt_id` |
| `citizen_resolve_did` | `GET /api/v1/identity/:did` |
| ... | _(32 more mappings)_ |

The HTTP client (`client.ts`) handles URL construction, JSON serialization, API key headers, and error parsing. Each tool calls one client method.

### Builder Tools: No Node Required

The 7 builder tools (`build_entry`, `build_envelope`, `build_multisig_envelope`, `build_namespace_ruleset`, `validate_entry_structure`, `generate_keypair`, `sign_entry`) execute entirely on the MCP server process. They use Node.js built-in `crypto` module — no external dependencies.

This means you can use the MCP server for development even without a running node. Design entries, generate keys, and prototype structures offline. Then connect a node to test submission.

### Error Handling

When a tool fails, the MCP server returns an error response with:

- The tool name
- The HTTP status code (if the error came from the node)
- The response body (if available)
- A human-readable message

The AI assistant receives this error and can suggest fixes (e.g., "the namespace requires a consent_policy — add one to your entry").

---

## Troubleshooting

### "Connection refused" when calling query tools

```
Tool "citizen_list_namespaces" failed: Citizen API GET /namespaces failed: ECONNREFUSED
```

- Verify the Citizen node is running: `curl http://localhost:7001/health`
- Check `CITIZEN_NODE_URL` is correct
- Ensure the node's API port is not firewalled

### "Tool failed: Missing required field"

The entry you built is missing required fields. Use `citizen_validate_entry_structure` to check before submitting.

### "Signature verification failed"

The signature on your entry doesn't match the author's public key. Ensure:

1. You signed the canonicalized entry (sorted keys, no whitespace)
2. The `author` field matches the DID derived from your signing key
3. You're using Ed25519, not another algorithm

### Builder tools work but query tools fail

This means the MCP server is running correctly but can't reach the node. Check your network connection to the node URL.

### Claude Desktop doesn't show Citizen tools

- Restart Claude Desktop after editing the config file
- Use absolute paths in the `args` array (not relative paths)
- Check the Claude Desktop logs for MCP connection errors
- Verify `node` is in the PATH that Claude Desktop uses

---

## Security Considerations

### Private Keys

The `citizen_generate_keypair` and `citizen_sign_entry` tools handle Ed25519 private keys. These tools:

- Generate keys in-memory using Node.js `crypto`
- Never persist keys to disk
- Never transmit keys over the network
- Return keys to the AI client only (which renders them in your conversation)

**Best practice**: For production, use a hardware-backed signer (like the Citizen mobile wallet) instead of generating keys through the MCP server. The MCP server's signing tools are for development and prototyping.

### API Keys

If your node requires an API key, set it via `CITIZEN_API_KEY`. The key is passed as an `x-api-key` header on every HTTP request. The key is never logged.

### Read-Only vs. Write Tools

Query tools (32) are safe — they only read data. Action tools (10) modify state. In production:

- Run the MCP server with a node that has limited write permissions where possible
- Review what the AI is submitting before confirming
- Use the `allowed_actions` namespace policy to restrict what actions are permitted

---

## Comparison: MCP Server vs. TypeScript SDK

| Aspect | MCP Server | TypeScript SDK |
|---|---|---|
| **Interface** | Natural language via AI assistant | Programmatic (TypeScript/JavaScript code) |
| **Audience** | Developers prototyping, exploring, learning | Applications in production |
| **Signing** | Built-in Ed25519 (dev keys) | Bring your own signer (wallet, HSM) |
| **State** | Stateless (each tool call is independent) | Stateful (client instance, sessions) |
| **Use case** | "Build me a namespace with voting policies" | `client.submitTransaction({ ... })` |

They complement each other: use the MCP server to prototype and explore, then switch to the SDK for production code.

---

## Exercises

### Exercise 1: First Exploration

Start a Citizen node and use the MCP server to explore the network.

1. Start a local node: `cd citizen-protocol && ./scripts/run_solo.sh`
2. Connect Claude Desktop (or your MCP client) to the MCP server
3. Ask the AI: "Check if the Citizen node is healthy"
4. Ask: "List all namespaces on the network"
5. Ask: "Show me the 5 most recent blocks"
6. Ask: "List entries in the first namespace you find"

**Check**: You should see the genesis namespaces and at least block height 0.

### Exercise 2: Build and Sign an Entry

Practice the transaction lifecycle without submitting.

1. Ask the AI to generate a new Ed25519 keypair
2. Ask it to build an entry in the `asset.registry` namespace with action `CREATE`
3. Ask it to sign the entry using the generated private key
4. Ask it to validate the entry structure
5. Examine the canonical JSON form and the data hash

**Check**: The entry should have a valid hex signature and the validation should report `valid: true`.

### Exercise 3: Submit and Verify

Complete the full submit cycle.

1. Start a local node (Exercise 1)
2. Generate a keypair and build a signed entry (Exercise 2)
3. Wrap the signed entry in a SignedEnvelope
4. Submit the envelope to the node
5. Poll for the receipt until status is `Accepted`
6. Verify the receipt contains a `finality` proof with block height and hash
7. Query the block at that height and find your entry in it

**Check**: The receipt should show `status: "Accepted"` and the block should contain your entry's `entry_id`.

### Exercise 4: Design a Custom Namespace

Design a namespace for a specific use case.

1. Pick a use case: supply chain tracking, academic credentials, or healthcare records
2. Ask the AI to help you choose appropriate validation policies (reference `citizen://protocol/policies`)
3. Build the namespace ruleset using `citizen_build_namespace_ruleset`
4. Discuss with the AI: which policies should be required vs. optional?
5. Write a sample entry that would pass your namespace's validation
6. Write a sample entry that would **fail** validation, and explain why

**Check**: Your ruleset should include at least `require_signature` and `allowed_actions`. The failing entry should violate at least one policy.

### Exercise 5: Multisig Treasury

Set up a multisig workflow.

1. Generate 5 keypairs for 5 signers
2. Build a multisig envelope with threshold = 3
3. Sign with the primary signer
4. Simulate collecting 2 co-signatures (sign with 2 more keypairs)
5. Verify the envelope now meets the threshold
6. Build a namespace ruleset with `envelope_multisig_policy` requiring min_threshold = 3

**Check**: The final envelope should have 3 signatures (1 primary + 2 co-signatures) and meet the threshold requirement.

### Exercise 6: Privacy-Aware Entry

Design an encrypted entry with consent.

1. Choose a data type: medical record, financial statement, or legal document
2. Design the consent receipt (subject DID, policy ref, expiry, authorized readers)
3. Set up per-field reader ACLs (e.g., `diagnosis` → doctor DID only, `billing` → insurance DID only)
4. Build the entry with `privacy_flag = true` and `privacy_mode = "Hybrid"`
5. Design the namespace ruleset with `consent_policy` and `privacy_policy`
6. Explain what happens when an unauthorized reader tries to access the data

**Check**: The entry should have `privacy_flag: true`, a consent receipt with expiry, and per-field ACLs. The namespace should enforce both consent and privacy policies.

### Exercise 7: Civic Voting Query

Explore the civic voting system.

1. Start a node with civic namespaces active
2. List all civic elections: `citizen_list_civic_elections`
3. Pick an election and check its tally: `citizen_get_election_tally`
4. List ballots: `citizen_get_election_ballots`
5. Check voter eligibility for a specific DID: `citizen_check_voter_eligibility`
6. Check if a DID is a civic admin: `citizen_check_civic_admin`
7. Summarize the election state in plain English

**Check**: You should be able to describe the election status (open/closed), current leading candidate, total ballots cast, and whether a given DID is eligible to vote.

### Exercise 8: Build a Complete dApp Prompt

Use the guided prompts to design a full dApp.

1. Use the `create-dapp` prompt with a specific app idea (e.g., "Land Registry", "Academic Credentials", "Public Petitions")
2. Follow the AI's guidance step by step
3. Design the namespace(s) needed
4. Define the core transaction types (actions and payloads)
5. Write the TypeScript SDK code for the main flows
6. Identify which policies apply
7. Document the dApp's architecture in a README

**Check**: You should have a complete design document with namespace definitions, entry structures, policy requirements, and working code examples.

---

## Next Steps

- [TypeScript SDK](../sdk/typescript.md) — Programmatic integration for production dApps
- [Namespaces](../protocol/namespaces.md) — Deep dive into namespace policies and governance
- [API Reference](../reference/api.md) — Raw HTTP endpoint documentation
- [Civic Voting](../protocol/civic-voting.md) — Civic engagement on Citizen Protocol
- [Running a Node](../node-operators/running-a-node.md) — Set up a local node for development
