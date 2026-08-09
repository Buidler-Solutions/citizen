import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "./query.js";

export const builderTools: ToolDefinition[] = [
  {
    name: "citizen_build_entry",
    description:
      "Build a well-formed LedgerEntry structure from components. " +
      "Generates a UUID entry_id and current timestamp automatically. " +
      "The entry must still be signed before submission. " +
      "Use this when constructing transactions programmatically.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Namespace identifier (e.g. 'gov.civic', 'builder.credits')" },
        action: { type: "string", description: "Action verb (e.g. CREATE, TRANSFER, UPDATE, VOTE, REGISTER)" },
        object_id: { type: "string", description: "The object being acted upon (unique identifier within the action scope)" },
        payload: { type: "object", description: "JSON payload containing action-specific data" },
        author: { type: "string", description: "DID of the author/signer" },
        privacy_flag: { type: "boolean", description: "Set to true if this entry contains encrypted data", default: false },
      },
      required: ["namespace", "action", "object_id", "payload", "author"],
    },
    handler: async (args) => {
      const now = Math.floor(Date.now() / 1000);
      return {
        entry_id: randomUUID(),
        namespace: args.namespace,
        action: args.action,
        object_id: args.object_id,
        payload: args.payload,
        author: args.author,
        timestamp: now,
        signature: null,
        privacy_flag: args.privacy_flag ?? false,
        privacy_mode: args.privacy_flag ? "Hybrid" : "None",
        authorized_readers: [],
        field_reader_acls: {},
        key_wrapped_secrets: [],
        _note: "Entry is unsigned. Generate an Ed25519 signature over the canonicalized entry (sorted keys, no whitespace) and set the 'signature' field before submitting.",
      };
    },
  },
  {
    name: "citizen_build_envelope",
    description:
      "Wrap a signed LedgerEntry into a SignedEnvelope structure for canonical submission. " +
      "Generates envelope_id and submitted_at automatically. " +
      "For multisig, use citizen_build_multisig_envelope instead.",
    inputSchema: {
      type: "object",
      properties: {
        entry: { type: "object", description: "A signed LedgerEntry" },
        signer: { type: "string", description: "DID of the signer (should match entry.author)" },
        signature: { type: "string", description: "Ed25519 signature over the canonicalized entry" },
        signature_scope: { type: "string", description: "Optional scope tag for replay protection" },
      },
      required: ["entry", "signer", "signature"],
    },
    handler: async (args) => ({
      envelope_id: randomUUID(),
      signer: args.signer,
      signature: args.signature,
      signature_scope: args.signature_scope ?? null,
      co_signatures: [],
      multisig_policy: null,
      submitted_at: new Date().toISOString(),
      payload: args.entry,
    }),
  },
  {
    name: "citizen_build_multisig_envelope",
    description:
      "Build a SignedEnvelope with a multisig threshold policy. " +
      "The envelope requires N-of-M signatures before it will be accepted by the ledger. " +
      "Generate the primary signature first, then collect co-signatures until the threshold is met.",
    inputSchema: {
      type: "object",
      properties: {
        entry: { type: "object", description: "A signed LedgerEntry" },
        primary_signer: { type: "string", description: "DID of the primary signer" },
        primary_signature: { type: "string", description: "Ed25519 signature from the primary signer" },
        threshold: { type: "number", description: "Number of signatures required (including primary)" },
        allowed_signers: {
          type: "array",
          items: { type: "string" },
          description: "List of DIDs allowed to co-sign",
        },
        require_author_signature: {
          type: "boolean",
          description: "If true, the entry.author must be among the signers",
          default: true,
        },
        signature_scope: { type: "string", description: "Optional scope tag for replay protection" },
      },
      required: ["entry", "primary_signer", "primary_signature", "threshold"],
    },
    handler: async (args) => ({
      envelope_id: randomUUID(),
      signer: args.primary_signer,
      signature: args.primary_signature,
      signature_scope: args.signature_scope ?? null,
      co_signatures: [],
      multisig_policy: {
        threshold: args.threshold,
        allowed_signers: args.allowed_signers ?? [],
        require_author_signature: args.require_author_signature ?? true,
      },
      submitted_at: new Date().toISOString(),
      payload: args.entry,
      _note: `Multisig envelope requires ${args.threshold} total signatures. Primary signature included. Collect ${Math.max(0, (args.threshold as number) - 1)} more co-signature(s) via appendCoSignature before submitting.`,
    }),
  },
  {
    name: "citizen_build_namespace_ruleset",
    description:
      "Build a complete namespace ruleset definition with validation policies. " +
      "This is the structure used to define or update a namespace via governance. " +
      "Each rule has a name and a JSON config — see citizen_describe_policy for details on each available policy.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Namespace identifier" },
        governed_by: { type: "string", description: "Governance scope (e.g. 'system', 'community')" },
        version: { type: "string", description: "Semantic version", default: "1.0.0" },
        writers: {
          type: "array",
          items: { type: "string" },
          description: "List of DIDs allowed to write to this namespace",
        },
        rules: {
          type: "array",
          description: "Validation policies for this namespace",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Policy name (see citizen_list_policies)" },
              config: { type: "object", description: "Policy-specific configuration" },
            },
            required: ["name"],
          },
        },
      },
      required: ["namespace", "rules"],
    },
    handler: async (args) => {
      const rules = (args.rules as Array<{ name: string; config?: unknown }>) ?? [];
      const rulesString = rules.map((r) => r.name).sort().join(",");
      let rulesHash = 0;
      for (let i = 0; i < rulesString.length; i++) {
        rulesHash = ((rulesHash << 5) - rulesHash + rulesString.charCodeAt(i)) | 0;
      }
      return {
        descriptor: {
          namespace: args.namespace,
          version: args.version ?? "1.0.0",
          rules_hash: `0x${(rulesHash >>> 0).toString(16).padStart(8, "0")}`,
          governed_by: args.governed_by ?? "community",
        },
        writers: args.writers ?? [],
        validators: rules,
        _note: "This ruleset must be submitted via a governance proposal (UpdateNamespace action) to be activated on the network.",
      };
    },
  },
  {
    name: "citizen_validate_entry_structure",
    description:
      "Validate that a LedgerEntry has all required fields with correct types before submission. " +
      "Returns a list of issues if any fields are missing or malformed.",
    inputSchema: {
      type: "object",
      properties: {
        entry: { type: "object", description: "The LedgerEntry to validate" },
      },
      required: ["entry"],
    },
    handler: async (args) => {
      const entry = args.entry as Record<string, unknown>;
      const issues: string[] = [];
      const required = ["namespace", "action", "object_id", "payload", "author", "signature", "timestamp"];
      for (const field of required) {
        if (entry[field] === undefined || entry[field] === null) {
          issues.push(`Missing required field: ${field}`);
        }
      }
      if (entry.timestamp !== undefined && typeof entry.timestamp !== "number") {
        issues.push("timestamp must be a number (Unix epoch seconds)");
      }
      if (entry.payload !== undefined && typeof entry.payload !== "object") {
        issues.push("payload must be a JSON object");
      }
      if (entry.privacy_flag === true) {
        if (!entry.payload_commitment) issues.push("privacy_flag is true but payload_commitment is missing");
        if (!entry.ciphertext_hex) issues.push("privacy_flag is true but ciphertext_hex is missing");
        if (!entry.nonce_hex) issues.push("privacy_flag is true but nonce_hex is missing");
      }
      return {
        valid: issues.length === 0,
        issues,
        entry_id: entry.entry_id ?? "(not set)",
      };
    },
  },
  {
    name: "citizen_generate_keypair",
    description:
      "Generate a new Ed25519 keypair for signing entries. Returns the public key (hex), private key (hex), " +
      "and a suggested DID. The private key should be stored securely and never shared. " +
      "This uses Node.js built-in crypto — no external dependencies.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const { generateKeyPairSync } = await import("node:crypto");
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const pubHex = publicKey.export({ type: "spki", format: "der" }).toString("hex");
      const privHex = privateKey.export({ type: "pkcs8", format: "der" }).toString("hex");
      const did = `did:key:z${pubHex.slice(0, 32)}`;
      return {
        algorithm: "Ed25519",
        public_key_hex: pubHex,
        private_key_hex: privHex,
        did,
        _warning: "Store the private key securely. Never expose it in client-side code or commit it to version control.",
      };
    },
  },
  {
    name: "citizen_sign_entry",
    description:
      "Sign a LedgerEntry using an Ed25519 private key. " +
      "Canonicalizes the entry (sorted keys, no whitespace) and produces a signature. " +
      "Returns the signed entry ready for envelope wrapping.",
    inputSchema: {
      type: "object",
      properties: {
        entry: { type: "object", description: "The unsigned LedgerEntry" },
        privateKeyHex: { type: "string", description: "Ed25519 private key in hex (PKCS8 DER)" },
      },
      required: ["entry", "privateKeyHex"],
    },
    handler: async (args) => {
      const { createPrivateKey, sign, createHash } = await import("node:crypto");
      const entry = args.entry as Record<string, unknown>;
      const signingEntry = { ...entry };
      delete signingEntry.signature;
      const canonical = JSON.stringify(signingEntry, Object.keys(signingEntry).sort());
      const keyDer = Buffer.from(args.privateKeyHex as string, "hex");
      const privateKey = createPrivateKey({ key: keyDer, format: "der", type: "pkcs8" });
      const signature = sign(null, Buffer.from(canonical, "utf-8"), privateKey).toString("hex");
      const dataHash = createHash("sha256").update(canonical).digest("hex");
      return {
        ...entry,
        signature,
        _signing_details: {
          canonical_form: canonical,
          data_hash: dataHash,
          algorithm: "Ed25519",
        },
      };
    },
  },
];
