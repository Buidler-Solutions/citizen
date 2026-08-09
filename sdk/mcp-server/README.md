# Citizen Protocol MCP Server

An MCP (Model Context Protocol) server for the Citizen Protocol blockchain. Lets AI assistants and developer tools interact with Citizen nodes, build dApp components, and access protocol reference data.

## Quick Start

```bash
cd sdk/mcp-server
npm install
npm run build
```

### Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `CITIZEN_NODE_URL` | `http://localhost:7001` | URL of the Citizen node API |
| `CITIZEN_API_KEY` | _(none)_ | Optional API key for authenticated nodes |

### Run

```bash
CITIZEN_NODE_URL=http://localhost:7001 npm start
```

## Integration

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

### VS Code (with MCP extension)

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

### Any MCP Client

The server uses stdio transport — compatible with any MCP-compliant client.

## What It Provides

### 49 Tools

#### Query Tools (32) — Read-only ledger access
- `citizen_health` — Node health check
- `citizen_list_blocks` / `citizen_get_block` — Block explorer
- `citizen_list_namespaces` — Namespace listing
- `citizen_list_entries` — Entry listing per namespace
- `citizen_get_receipt` — Receipt lookup with finality proof
- `citizen_resolve_did` / `citizen_get_kyc_status` — Identity resolution
- `citizen_get_governance_proposals` — Governance state
- `citizen_list_civic_proposals` / `citizen_get_civic_tally` — Civic proposals
- `citizen_list_civic_elections` / `citizen_get_election_tally` / `citizen_get_election_ballots` — Elections
- `citizen_check_voter_eligibility` / `citizen_check_civic_admin` / `citizen_check_civic_registry` — Civic checks
- `citizen_get_ctzn_status` / `citizen_get_ctzn_holders` / `citizen_get_ctzn_balance` — CTZN tokens
- `citizen_get_builder_credits` / `citizen_get_asset_positions` — Economic state
- `citizen_get_module_runtime` / `citizen_get_interop_status` — Modules & interop
- `citizen_get_file_manifest` / `citizen_list_file_alerts` — Off-chain files
- `citizen_get_payload_field_refs` / `citizen_get_payload_by_data_hash` — Payload lookups

#### Action Tools (10) — Write operations
- `citizen_submit_entry` — Submit raw LedgerEntry (legacy path)
- `citizen_submit_envelope` — Submit SignedEnvelope (canonical path)
- `citizen_submit_envelope_batch` — Batch submission
- `citizen_check_consent` — Validate ConsentReceipt
- `citizen_execute_module` — Execute WASM module
- `citizen_create_file_intent` / `citizen_commit_file` / `citizen_read_file` / `citizen_revoke_file_reader` — File lifecycle
- `citizen_commit_payload` — Commit encrypted payload refs

#### Builder Tools (7) — Client-side helpers
- `citizen_build_entry` — Construct a LedgerEntry with auto-generated UUID and timestamp
- `citizen_build_envelope` — Wrap a signed entry into a SignedEnvelope
- `citizen_build_multisig_envelope` — Build a threshold multisig envelope
- `citizen_build_namespace_ruleset` — Design a namespace with validation policies
- `citizen_validate_entry_structure` — Check entry has all required fields
- `citizen_generate_keypair` — Generate an Ed25519 keypair
- `citizen_sign_entry` — Sign an entry with a private key

### 10 Resources — Protocol Reference Data
- `citizen://protocol/types` — All type schemas (LedgerEntry, SignedEnvelope, Receipt, etc.)
- `citizen://protocol/policies` — All 21 namespace validation policies with configs
- `citizen://protocol/api-reference` — Complete HTTP endpoint reference
- `citizen://sdk/methods` — TypeScript SDK method reference
- `citizen://examples/submit-entry` — Code example: submit a signed entry
- `citizen://examples/multisig` — Code example: multisig transaction
- `citizen://examples/create-namespace` — Guide: namespace creation
- `citizen://examples/encrypted-entry` — Guide: privacy-aware entries
- `citizen://examples/civic-voting` — Guide: civic voting dApp
- `citizen://examples/builder-credits` — Guide: builder credits dApp

### 8 Prompts — Guided dApp Development
- `create-dapp` — New dApp from scratch
- `submit-transaction` — Submit a signed transaction
- `create-namespace` — Design and activate a namespace
- `query-ledger` — Read data from the ledger
- `setup-multisig` — Set up a multisig workflow
- `build-civic-app` — Civic engagement application
- `deploy-wasm-module` — WASM module deployment
- `privacy-design` — Privacy-aware entry design

## Architecture

```
sdk/mcp-server/
├── src/
│   ├── index.ts              # Entry point — stdio transport
│   ├── server.ts             # MCP server — registers tools/resources/prompts
│   ├── client.ts             # HTTP client wrapping all Citizen node endpoints
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

## How It Maps to the API

Every query and action tool maps 1:1 to a Citizen node HTTP endpoint. The builder tools run locally (no node required) to help developers construct valid protocol structures. This means an AI assistant can:

1. **Explore** — Query namespaces, blocks, entries, receipts, governance state
2. **Build** — Construct entries, envelopes, namespace rulesets, keypairs
3. **Submit** — Send signed transactions to the ledger
4. **Verify** — Poll receipts and check finality proofs
5. **Learn** — Access complete type schemas, policy references, and code examples

## License

Apache-2.0
