export interface PromptDefinition {
  name: string;
  description: string;
  arguments: Array<{
    name: string;
    description: string;
    required?: boolean;
  }>;
  handler: (args: Record<string, string>) => { role: "user"; content: { type: "text"; text: string } };
}

export const prompts: PromptDefinition[] = [
  {
    name: "create-dapp",
    description:
      "Guide a developer through creating a new dApp on Citizen Protocol from scratch. " +
      "Covers namespace design, entry structure, signing, submission, and receipt verification.",
    arguments: [
      { name: "appName", description: "Name of the dApp", required: true },
      { name: "description", description: "What the dApp does", required: true },
      { name: "features", description: "Key features (e.g. voting, asset tracking, credential issuance)" },
    ],
    handler: (args) => ({
      role: "user",
      content: {
        type: "text",
        text: `I want to build a dApp called "${args.appName}" on Citizen Protocol.

Description: ${args.description}
${args.features ? `Key features: ${args.features}` : ""}

Guide me through the complete process:
1. Design appropriate namespace(s) with validation policies (reference citizen://protocol/policies)
2. Define the LedgerEntry structure for the core transaction types
3. Show how to sign and submit entries via the SDK
4. Explain how to handle receipts and verify finality
5. Cover privacy/encryption if the dApp handles sensitive data
6. Provide code examples using the TypeScript SDK

Start by reading the protocol type schemas (citizen://protocol/types) and namespace policies (citizen://protocol/policies) to ground your recommendations.`,
      },
    }),
  },
  {
    name: "submit-transaction",
    description:
      "Step-by-step guide for submitting a signed transaction to the Citizen ledger. " +
      "Covers entry construction, Ed25519 signing, envelope wrapping, and receipt polling.",
    arguments: [
      { name: "namespace", description: "Target namespace", required: true },
      { name: "action", description: "Action verb (e.g. CREATE, TRANSFER, VOTE)", required: true },
      { name: "payloadDescription", description: "Description of what the payload should contain" },
    ],
    handler: (args) => ({
      role: "user",
      content: {
        type: "text",
        text: `Help me submit a transaction to Citizen Protocol.

Target namespace: ${args.namespace}
Action: ${args.action}
${args.payloadDescription ? `Payload should contain: ${args.payloadDescription}` : ""}

Please:
1. Use citizen_list_namespaces to verify the namespace exists and check its policies
2. Build the entry using citizen_build_entry with the correct fields
3. Show me how to sign it (generate a keypair if I don't have one)
4. Wrap it in an envelope and submit it
5. Wait for the receipt and show me the finality proof

Provide the complete code flow.`,
      },
    }),
  },
  {
    name: "create-namespace",
    description:
      "Guide for designing and activating a new namespace with appropriate validation policies. " +
      "Helps choose the right policies for the use case.",
    arguments: [
      { name: "purpose", description: "What the namespace will be used for", required: true },
      { name: "writers", description: "Who should be able to write to it (DIDs)" },
      { name: "privacyNeeded", description: "Does it need encryption/consent? (yes/no)" },
    ],
    handler: (args) => ({
      role: "user",
      content: {
        type: "text",
        text: `I need to create a new namespace on Citizen Protocol.

Purpose: ${args.purpose}
${args.writers ? `Writers: ${args.writers}` : "Writers: TBD"}
${args.privacyNeeded ? `Privacy needed: ${args.privacyNeeded}` : ""}

Help me:
1. Read citizen://protocol/policies to understand all available validation policies
2. Recommend which policies are appropriate for this use case
3. Use citizen_build_namespace_ruleset to construct the ruleset
4. Explain the governance proposal process to activate it
5. Show example entries that would pass validation`,
      },
    }),
  },
  {
    name: "query-ledger",
    description:
      "Guide for reading data from the Citizen ledger. Helps construct the right queries for blocks, entries, namespaces, receipts, and civic data.",
    arguments: [
      { name: "whatToFind", description: "What information are you looking for?", required: true },
    ],
    handler: (args) => ({
      role: "user",
      content: {
        type: "text",
        text: `I need to find information on the Citizen ledger: ${args.whatToFind}

Help me:
1. Identify which query tool(s) to use
2. Run the appropriate queries (start with citizen_health to verify the node is online)
3. Interpret the results in the context of what I'm looking for
4. Show me how to paginate or filter if needed`,
      },
    }),
  },
  {
    name: "setup-multisig",
    description:
      "Complete guide for setting up a multisig workflow: key generation, threshold policy, co-signing, and submission.",
    arguments: [
      { name: "threshold", description: "How many signatures are required (e.g. 3-of-5)", required: true },
      { name: "useCase", description: "What is the multisig for? (e.g. treasury, governance, admin)" },
    ],
    handler: (args) => ({
      role: "user",
      content: {
        type: "text",
        text: `Help me set up a ${args.threshold} multisig workflow on Citizen Protocol.
${args.useCase ? `Use case: ${args.useCase}` : ""}

Guide me through:
1. Generating keypairs for all signers (use citizen_generate_keypair)
2. Building a multisig envelope (use citizen_build_multisig_envelope)
3. The co-signing collection process
4. Submitting the envelope once threshold is met
5. Setting up the namespace with envelope_multisig_policy

Read citizen://examples/multisig for reference patterns.`,
      },
    }),
  },
  {
    name: "build-civic-app",
    description:
      "Architecture guide for building civic engagement applications (voting, proposals, elections) on Citizen Protocol.",
    arguments: [
      { name: "appType", description: "Type of civic app (voting, petition, town-hall, budget)", required: true },
      { name: "jurisdiction", description: "Geographic or organizational scope" },
    ],
    handler: (args) => ({
      role: "user",
      content: {
        type: "text",
        text: `I want to build a civic ${args.appType} application on Citizen Protocol.
${args.jurisdiction ? `Jurisdiction: ${args.jurisdiction}` : ""}

Help me design the complete architecture:
1. Which namespaces and policies to use (reference citizen://protocol/policies)
2. How to handle voter registration and KYC
3. How to create proposals or elections
4. How ballots are submitted and tallied
5. How to display real-time results
6. Code examples for the core flows

Read citizen://examples/civic-voting for reference patterns and explore the civic query tools.`,
      },
    }),
  },
  {
    name: "deploy-wasm-module",
    description:
      "Guide for deploying and interacting with WASM execution modules on Citizen Protocol. Covers governance gating, module execution, and runtime queries.",
    arguments: [
      { name: "moduleName", description: "Name of the module", required: true },
      { name: "functionality", description: "What the module should do", required: true },
    ],
    handler: (args) => ({
      role: "user",
      content: {
        type: "text",
        text: `I want to deploy a WASM module called "${args.moduleName}" on Citizen Protocol.
Functionality: ${args.functionality}

Help me understand:
1. How WASM modules are governance-gated on Citizen
2. The wasm_runtime_policy configuration
3. How to compile and submit a module
4. Wallet ownership — only the deployer can upgrade or activate the contract
5. How to execute it via citizen_execute_module
6. How to query its runtime state via citizen_get_module_runtime

Note: WASM execution is a scoped, optional layer on Citizen Protocol — it must be governance-approved. Smart contracts are owned by the wallet that deploys them; no other wallet can modify or upgrade the contract.`,
      },
    }),
  },
  {
    name: "privacy-design",
    description:
      "Guide for designing privacy-aware entries with encryption, consent receipts, and per-field reader ACLs.",
    arguments: [
      { name: "dataType", description: "What kind of data needs privacy?", required: true },
      { name: "readers", description: "Who should be able to read the data?" },
    ],
    handler: (args) => ({
      role: "user",
      content: {
        type: "text",
        text: `I need to design a privacy-aware entry for ${args.dataType} on Citizen Protocol.
${args.readers ? `Authorized readers: ${args.readers}` : ""}

Help me:
1. Choose the right privacy mode (Passphrase vs Hybrid)
2. Design the consent receipt
3. Set up per-field reader ACLs for granular access
4. Configure the namespace with consent_policy and privacy_policy
5. Show the complete entry structure

Read citizen://examples/encrypted-entry for reference patterns.`,
      },
    }),
  },
];
