import type { ToolDefinition, ToolContext } from "./query.js";

export const actionTools: ToolDefinition[] = [
  {
    name: "citizen_submit_entry",
    description:
      "Submit a raw LedgerEntry to the node for validation and inclusion in a block. " +
      "The entry must be pre-signed by the author. Prefer citizen_submit_envelope for canonical submission. " +
      "Required fields: namespace, action, object_id, payload, author, signature, timestamp.",
    inputSchema: {
      type: "object",
      properties: {
        entry: {
          type: "object",
          description: "A complete LedgerEntry object",
          properties: {
            namespace: { type: "string", description: "Namespace identifier" },
            action: { type: "string", description: "Action verb (e.g. CREATE, TRANSFER, VOTE)" },
            object_id: { type: "string", description: "Object being acted upon" },
            payload: { type: "object", description: "JSON payload for the action" },
            author: { type: "string", description: "DID of the entry author" },
            signature: { type: "string", description: "Ed25519 signature over the canonicalized entry" },
            timestamp: { type: "number", description: "Unix timestamp" },
            privacy_flag: { type: "boolean", description: "Whether this entry contains encrypted data" },
          },
          required: ["namespace", "action", "object_id", "payload", "author", "signature", "timestamp"],
        },
      },
      required: ["entry"],
    },
    handler: async (args, { client }) => client.submitEntry(args.entry),
  },
  {
    name: "citizen_submit_envelope",
    description:
      "Submit a signed envelope (the canonical submission path) to the node. " +
      "An envelope wraps a LedgerEntry with signer identity, signature, optional co-signatures, and optional multisig policy. " +
      "This is the preferred way to submit transactions on Citizen Protocol.",
    inputSchema: {
      type: "object",
      properties: {
        envelope: {
          type: "object",
          description: "A complete SignedEnvelope<LedgerEntry> object",
          properties: {
            envelope_id: { type: "string", description: "UUID for this envelope" },
            signer: { type: "string", description: "Primary signer DID" },
            signature: { type: "string", description: "Ed25519 signature" },
            signature_scope: { type: "string", description: "Optional scope tag for replay protection" },
            co_signatures: {
              type: "array",
              description: "Additional co-signers",
              items: {
                type: "object",
                properties: {
                  signer: { type: "string" },
                  signature: { type: "string" },
                },
              },
            },
            multisig_policy: {
              type: "object",
              description: "Multisig threshold policy",
              properties: {
                threshold: { type: "number" },
                allowed_signers: { type: "array", items: { type: "string" } },
                require_author_signature: { type: "boolean" },
              },
            },
            submitted_at: { type: "string", description: "ISO 8601 timestamp" },
            payload: { type: "object", description: "The LedgerEntry being submitted" },
          },
          required: ["envelope_id", "signer", "signature", "submitted_at", "payload"],
        },
      },
      required: ["envelope"],
    },
    handler: async (args, { client }) => client.submitEnvelope(args.envelope),
  },
  {
    name: "citizen_submit_envelope_batch",
    description:
      "Submit a batch of signed envelopes in a single request. Useful for high-throughput dApps that aggregate multiple transactions.",
    inputSchema: {
      type: "object",
      properties: {
        envelopes: {
          type: "array",
          description: "Array of SignedEnvelope<LedgerEntry> objects (must be non-empty)",
          items: { type: "object" },
        },
      },
      required: ["envelopes"],
    },
    handler: async (args, { client }) => client.submitEnvelopeBatch(args.envelopes as unknown[]),
  },
  {
    name: "citizen_check_consent",
    description:
      "Validate a ConsentReceipt against the ledger's consent policy. " +
      "ConsentReceipts prove that a data subject consented to data processing, with expiry, reader authorization, and per-field ACLs.",
    inputSchema: {
      type: "object",
      properties: {
        consentReceipt: {
          type: "object",
          description: "A ConsentReceipt object",
          properties: {
            subject_did: { type: "string" },
            data_hash: { type: "string" },
            policy_ref: { type: "string" },
            granted_at: { type: "number" },
            expires_at: { type: "number" },
            authorized_readers: { type: "array", items: { type: "string" } },
          },
          required: ["subject_did", "data_hash", "policy_ref", "granted_at", "expires_at"],
        },
      },
      required: ["consentReceipt"],
    },
    handler: async (args, { client }) => client.checkConsent(args.consentReceipt),
  },
  {
    name: "citizen_execute_module",
    description:
      "Execute a WASM module deployed on the network. Modules are governance-gated execution units — " +
      "this tool invokes a module's entrypoint with a JSON payload and returns the result.",
    inputSchema: {
      type: "object",
      properties: {
        moduleId: { type: "string", description: "Module identifier" },
        payload: { type: "object", description: "JSON payload to pass to the module entrypoint" },
      },
      required: ["moduleId", "payload"],
    },
    handler: async (args, { client }) => client.executeModule(args.moduleId as string, args.payload),
  },
  {
    name: "citizen_create_file_intent",
    description:
      "Create an intent to upload an encrypted file to the off-chain object store. " +
      "Returns upload parameters. The actual file is encrypted client-side before upload.",
    inputSchema: {
      type: "object",
      properties: {
        intent: {
          type: "object",
          description: "File upload intent",
          properties: {
            namespace: { type: "string" },
            owner_did: { type: "string" },
            content_type: { type: "string" },
            size_bytes: { type: "number" },
            data_hash: { type: "string" },
          },
        },
      },
      required: ["intent"],
    },
    handler: async (args, { client }) => client.createFileIntent(args.intent),
  },
  {
    name: "citizen_commit_file",
    description: "Commit an uploaded encrypted file, linking it to a ledger entry via payload commitment.",
    inputSchema: {
      type: "object",
      properties: {
        commit: {
          type: "object",
          description: "File commit request",
        },
      },
      required: ["commit"],
    },
    handler: async (args, { client }) => client.commitFile(args.commit),
  },
  {
    name: "citizen_read_file",
    description: "Read an encrypted file from the off-chain store. Access is privacy-gated — the reader must be in the authorized_readers list.",
    inputSchema: {
      type: "object",
      properties: {
        readRequest: {
          type: "object",
          description: "File read request with manifest ID and reader DID",
        },
      },
      required: ["readRequest"],
    },
    handler: async (args, { client }) => client.readFile(args.readRequest),
  },
  {
    name: "citizen_revoke_file_reader",
    description: "Revoke a reader's access to an encrypted file. Generates a revocation event on the ledger.",
    inputSchema: {
      type: "object",
      properties: {
        revokeRequest: {
          type: "object",
          description: "Revocation request with manifest ID and reader DID",
        },
      },
      required: ["revokeRequest"],
    },
    handler: async (args, { client }) => client.revokeFileReader(args.revokeRequest),
  },
  {
    name: "citizen_commit_payload",
    description: "Commit encrypted payload field references to the ledger. Used for entries with hybrid encryption where individual fields have their own DEKs and reader ACLs.",
    inputSchema: {
      type: "object",
      properties: {
        commit: {
          type: "object",
          description: "Payload commitment with field-level encryption metadata",
        },
      },
      required: ["commit"],
    },
    handler: async (args, { client }) => client.commitPayload(args.commit),
  },
];
