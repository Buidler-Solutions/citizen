import { CitizenNodeClient, type ModuleExecuteResponse } from "./client.ts";

/**
 * Typed wrappers around the TreasureNet WASM modules:
 *
 * - treasure-escrow.v1   (escrowed rewards lifecycle, 2-of-2 claim, expiry refunds)
 * - treasure-hunt.v1     (hunt lifecycle)
 * - player-registry.v1   (soulbound roles)
 * - citizen-asset.v1     (transferable reward tokens + timed multisig vault custody)
 *
 * Every chain write goes through submitWithRetry which handles the three
 * required failure modes: node down (retry queue), rejected entry (surface
 * the module error verbatim), and non-final receipts (poll until inclusion).
 */

export const MODULES = {
  escrow: "treasure-escrow.v1",
  hunt: "treasure-hunt.v1",
  registry: "player-registry.v1",
  asset: "citizen-asset.v1",
} as const;

export class ModuleError extends Error {
  readonly moduleId: string;
  readonly operation: string;
  readonly code: string;

  constructor(moduleId: string, operation: string, code: string) {
    super(`${moduleId}.${operation} rejected: ${code}`);
    this.name = "ModuleError";
    this.moduleId = moduleId;
    this.operation = operation;
    this.code = code;
  }
}

export interface ChainWriteMeta {
  module_id: string;
  gas_consumed: number;
  receipt_block?: number;
}

function unwrap(
  response: ModuleExecuteResponse,
  moduleId: string,
  operation: string
): { output: Record<string, unknown>; meta: ChainWriteMeta } {
  if (!response.success) {
    throw new Error(`${moduleId}.${operation} failed: ${response.error ?? "unknown"}`);
  }
  const output = response.result ?? {};
  if (output.ok === false) {
    throw new ModuleError(
      moduleId,
      operation,
      (output.error as string) ?? (output.reason as string) ?? "unknown"
    );
  }
  return {
    output,
    meta: {
      module_id: moduleId,
      gas_consumed: response.gas_consumed ?? 0,
      receipt_block: output.receipt_block as number | undefined,
    },
  };
}

export interface RetryOptions {
  maxAttempts: number;
  backoffMs: number;
}

const DEFAULT_RETRY: RetryOptions = { maxAttempts: 5, backoffMs: 250 };

/** The chain adapter surface shared by the real node client and the mock. */
export interface ChainAdapter {
  execute(
    moduleId: string,
    params: Record<string, unknown>
  ): Promise<{ output: Record<string, unknown>; meta: ChainWriteMeta }>;
}

/** Durable backing for the retry queue (Postgres/Redis adapter injected by the server). */
export interface RetryQueueStore {
  enqueue(item: { moduleId: string; operation: string; params: Record<string, unknown>; attempts: number }): Promise<{ id: string }>;
  dequeue(id: string): Promise<void>;
  bumpAttempts(id: string, attempts: number): Promise<void>;
  load(): Promise<Array<{ id: string; moduleId: string; operation: string; params: Record<string, unknown>; attempts: number }>>;
}

export class ModuleGateway implements ChainAdapter {
  private retryQueue: Array<{
    id: string;
    moduleId: string;
    operation: string;
    params: Record<string, unknown>;
    attempts: number;
  }> = [];
  private readonly replayScopes = new Set<string>();

  private readonly client: CitizenNodeClient;
  private readonly retry: RetryOptions;
  private readonly queueStore?: RetryQueueStore;

  constructor(client: CitizenNodeClient, retry: RetryOptions = DEFAULT_RETRY, queueStore?: RetryQueueStore) {
    this.client = client;
    this.retry = retry;
    this.queueStore = queueStore;
  }

  /** Restore persisted retry items after a restart (durable queue). */
  async restoreRetryQueue(): Promise<number> {
    if (!this.queueStore) return 0;
    const items = await this.queueStore.load();
    for (const item of items) {
      this.retryQueue.push(item);
    }
    return items.length;
  }

  /** Drain the retry queue after a node outage. Returns failures. */
  async flushRetryQueue(): Promise<Array<{ moduleId: string; error: string }>> {
    const failures: Array<{ moduleId: string; error: string }> = [];
    const draining = [...this.retryQueue];
    this.retryQueue = [];
    for (const item of draining) {
      try {
        await this.execute(item.moduleId, item.params);
        await this.queueStore?.dequeue(item.id);
      } catch (error) {
        if (item.attempts + 1 >= this.retry.maxAttempts) {
          await this.queueStore?.dequeue(item.id);
          failures.push({
            moduleId: item.moduleId,
            error: error instanceof Error ? error.message : String(error),
          });
        } else {
          const bumped = { ...item, attempts: item.attempts + 1 };
          this.retryQueue.push(bumped);
          await this.queueStore?.bumpAttempts(item.id, bumped.attempts);
        }
      }
    }
    return failures;
  }

  pendingRetries(): number {
    return this.retryQueue.length;
  }

  async execute(
    moduleId: string,
    params: Record<string, unknown>
  ): Promise<{ output: Record<string, unknown>; meta: ChainWriteMeta }> {
    const scope = `${moduleId}:${params.operation}:${
      params.escrow_id ?? params.hunt_id ?? params.vault_id ?? params.ref ?? params.token_id ?? params.player_did ?? params.did ?? ""
    }`;
    // Idempotency: same envelope scope replayed in-process is rejected.
    if (this.replayScopes.has(scope) && isWriteOperation(params.operation)) {
      throw new ModuleError(moduleId, String(params.operation), "ReplayedSubmission");
    }
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < this.retry.maxAttempts; attempt++) {
      try {
        const response = await this.client.executeModule(moduleId, params);
        const result = unwrap(response, moduleId, String(params.operation));
        if (isWriteOperation(params.operation)) {
          this.replayScopes.add(scope);
        }
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (error instanceof ModuleError) {
          // Rejected entry: surface the ruleset/module error, never retry.
          throw error;
        }
        // Node down / transient failure: back off and retry.
        await new Promise((resolve) => setTimeout(resolve, this.retry.backoffMs));
      }
    }
    const durable = this.queueStore
      ? await this.queueStore.enqueue({ moduleId, operation: String(params.operation), params, attempts: this.retry.maxAttempts })
      : { id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
    this.retryQueue.push({ id: durable.id, moduleId, operation: String(params.operation), params, attempts: this.retry.maxAttempts });
    throw new Error(`${moduleId} unreachable after retries: ${lastError?.message}`);
  }

  // ── Escrow module ──

  configureEscrow(adminDid: string, oracles: string[], proposalId: string) {
    return this.execute(MODULES.escrow, {
      operation: "configure",
      admin_did: adminDid,
      oracles: oracles.join(","),
      proposal_id: proposalId,
    });
  }

  initEscrow(input: {
    escrow_id: string;
    owner_did: string;
    claimer_did: string;
    amount: number;
    token?: string;
    deadline_block: number;
  }) {
    return this.execute(MODULES.escrow, {
      operation: "init",
      escrow_id: input.escrow_id,
      owner_did: input.owner_did,
      claimer_did: input.claimer_did,
      amount: String(input.amount),
      token: input.token ?? "CTZN",
      deadline_block: String(input.deadline_block),
    });
  }

  fundEscrow(escrowId: string, funderDid: string, signature: string) {
    return this.execute(MODULES.escrow, {
      operation: "fund",
      escrow_id: escrowId,
      funder_did: funderDid,
      signature,
    });
  }

  /** 2-of-2 multisig claim: Game Master + oracle co-signatures. */
  claimEscrow(
    escrowId: string,
    winnerDid: string,
    gmSignature: string,
    oracleSignature: string,
    gmDid: string,
    oracleDid: string
  ) {
    return this.execute(MODULES.escrow, {
      operation: "claim",
      escrow_id: escrowId,
      winner_did: winnerDid,
      cosigner_dids: `${gmDid},${oracleDid}`,
      signatures: `${gmSignature},${oracleSignature}`,
    });
  }

  refundEscrow(escrowId: string, ownerDid: string, signature: string) {
    return this.execute(MODULES.escrow, {
      operation: "refund",
      escrow_id: escrowId,
      owner_did: ownerDid,
      signature,
    });
  }

  getEscrowStatus(escrowId: string) {
    return this.execute(MODULES.escrow, {
      operation: "get_status",
      escrow_id: escrowId,
    });
  }

  getEscrowReward(escrowId: string) {
    return this.execute(MODULES.escrow, {
      operation: "get_reward",
      escrow_id: escrowId,
    });
  }

  isEscrowExpired(escrowId: string) {
    return this.execute(MODULES.escrow, {
      operation: "is_expired",
      escrow_id: escrowId,
    });
  }

  // ── Hunt module ──

  configureHunt(adminDid: string, oracles: string[], proposalId: string) {
    return this.execute(MODULES.hunt, {
      operation: "configure",
      admin_did: adminDid,
      oracles: oracles.join(","),
      proposal_id: proposalId,
    });
  }

  createHunt(input: {
    hunt_id: string;
    gm_did: string;
    signature: string;
    reward_amount: number;
    reward_token?: string;
    expires_block: number;
    escrow_id?: string;
  }) {
    return this.execute(MODULES.hunt, {
      operation: "create_hunt",
      hunt_id: input.hunt_id,
      gm_did: input.gm_did,
      signature: input.signature,
      reward_amount: String(input.reward_amount),
      reward_token: input.reward_token ?? "CTZN",
      expires_block: String(input.expires_block),
      escrow_id: input.escrow_id ?? "",
    });
  }

  fundHunt(huntId: string, funderDid: string, signature: string, amount: number) {
    return this.execute(MODULES.hunt, {
      operation: "fund_hunt",
      hunt_id: huntId,
      funder_did: funderDid,
      signature,
      amount: String(amount),
    });
  }

  activateHunt(huntId: string, gmDid: string, signature: string) {
    return this.execute(MODULES.hunt, {
      operation: "activate",
      hunt_id: huntId,
      gm_did: gmDid,
      signature,
    });
  }

  pauseHunt(huntId: string, gmDid: string, signature: string) {
    return this.execute(MODULES.hunt, {
      operation: "pause",
      hunt_id: huntId,
      gm_did: gmDid,
      signature,
    });
  }

  resumeHunt(huntId: string, gmDid: string, signature: string) {
    return this.execute(MODULES.hunt, {
      operation: "resume",
      hunt_id: huntId,
      gm_did: gmDid,
      signature,
    });
  }

  cancelHunt(huntId: string, gmDid: string, signature: string) {
    return this.execute(MODULES.hunt, {
      operation: "cancel",
      hunt_id: huntId,
      gm_did: gmDid,
      signature,
    });
  }

  claimHunt(
    huntId: string,
    winnerDid: string,
    gmDid: string,
    gmSignature: string,
    oracleDid: string,
    oracleSignature: string
  ) {
    return this.execute(MODULES.hunt, {
      operation: "claim",
      hunt_id: huntId,
      winner_did: winnerDid,
      cosigner_dids: `${gmDid},${oracleDid}`,
      signatures: `${gmSignature},${oracleSignature}`,
    });
  }

  refundHunt(huntId: string, gmDid: string, signature: string) {
    return this.execute(MODULES.hunt, {
      operation: "refund",
      hunt_id: huntId,
      gm_did: gmDid,
      signature,
    });
  }

  getHunt(huntId: string) {
    return this.execute(MODULES.hunt, { operation: "get_hunt", hunt_id: huntId });
  }

  // ── Player registry module ──

  configureRegistry(adminDid: string, proposalId: string) {
    return this.execute(MODULES.registry, {
      operation: "configure",
      admin_did: adminDid,
      proposal_id: proposalId,
    });
  }

  grantRole(adminDid: string, adminSignature: string, playerDid: string, role: string) {
    return this.execute(MODULES.registry, {
      operation: "grant_role",
      admin_did: adminDid,
      signature: adminSignature,
      player_did: playerDid,
      role,
    });
  }

  revokeRole(adminDid: string, adminSignature: string, playerDid: string) {
    return this.execute(MODULES.registry, {
      operation: "revoke_role",
      admin_did: adminDid,
      signature: adminSignature,
      player_did: playerDid,
    });
  }

  roleOf(did: string) {
    return this.execute(MODULES.registry, { operation: "role_of", did });
  }

  isRegistered(did: string) {
    return this.execute(MODULES.registry, { operation: "is_registered", did });
  }

  hasRole(did: string, role: string) {
    return this.execute(MODULES.registry, { operation: "has_role", did, role });
  }

  // ── Citizen asset module (transferable tokens + vault custody) ──

  configureAsset(adminDid: string, issuers: string[], threshold: number, proposalId: string, adminSig?: string) {
    return this.execute(MODULES.asset, {
      operation: "configure",
      admin_did: adminDid,
      issuers: issuers.join(","),
      threshold: String(threshold),
      proposal_id: proposalId,
      ...(adminSig ? { admin_sig: adminSig } : {}),
    });
  }

  createAssetToken(input: { token_id: string; symbol: string; decimals?: number; issuer_dids: string[]; signatures: string[] }) {
    return this.execute(MODULES.asset, {
      operation: "create_token",
      token_id: input.token_id,
      symbol: input.symbol,
      decimals: String(input.decimals ?? 0),
      issuer_dids: input.issuer_dids.join(","),
      signatures: input.signatures.join(","),
    });
  }

  mintAsset(input: { token_id: string; recipient_did: string; amount: number; ref: string; issuer_dids: string[]; signatures: string[] }) {
    return this.execute(MODULES.asset, {
      operation: "mint",
      token_id: input.token_id,
      recipient_did: input.recipient_did,
      amount: String(input.amount),
      ref: input.ref,
      issuer_dids: input.issuer_dids.join(","),
      signatures: input.signatures.join(","),
    });
  }

  transferAsset(input: { token_id: string; from_did: string; to_did: string; amount: number; ref: string; signature: string }) {
    return this.execute(MODULES.asset, {
      operation: "transfer",
      token_id: input.token_id,
      from_did: input.from_did,
      to_did: input.to_did,
      amount: String(input.amount),
      ref: input.ref,
      signature: input.signature,
    });
  }

  burnAsset(input: { token_id: string; owner_did: string; amount: number; ref: string; signature: string }) {
    return this.execute(MODULES.asset, {
      operation: "burn",
      token_id: input.token_id,
      owner_did: input.owner_did,
      amount: String(input.amount),
      ref: input.ref,
      signature: input.signature,
    });
  }

  openAssetVault(input: {
    vault_id: string;
    token_id: string;
    approver_dids: string[];
    threshold: number;
    expiry_block: number;
    fallback_owner_did: string;
    admin_did: string;
    admin_sig: string;
  }) {
    return this.execute(MODULES.asset, {
      operation: "open_vault",
      vault_id: input.vault_id,
      token_id: input.token_id,
      approver_dids: input.approver_dids.join(","),
      threshold: String(input.threshold),
      expiry_block: String(input.expiry_block),
      fallback_owner_did: input.fallback_owner_did,
      admin_did: input.admin_did,
      admin_sig: input.admin_sig,
    });
  }

  vaultTransfer(input: { vault_id: string; token_id: string; to_did: string; amount: number; ref: string; cosigner_dids: string[]; signatures: string[] }) {
    return this.execute(MODULES.asset, {
      operation: "vault_transfer",
      vault_id: input.vault_id,
      token_id: input.token_id,
      to_did: input.to_did,
      amount: String(input.amount),
      ref: input.ref,
      cosigner_dids: input.cosigner_dids.join(","),
      signatures: input.signatures.join(","),
    });
  }

  vaultInfo(vaultId: string) {
    return this.execute(MODULES.asset, { operation: "vault_info", vault_id: vaultId });
  }

  assetBalance(tokenId: string, did: string) {
    return this.execute(MODULES.asset, { operation: "balance", token_id: tokenId, did });
  }

  assetTokenInfo(tokenId: string) {
    return this.execute(MODULES.asset, { operation: "token_info", token_id: tokenId });
  }
}

function isWriteOperation(operation: unknown): boolean {
  return ![
    "get_status",
    "get_reward",
    "is_expired",
    "get_hunt",
    "role_of",
    "is_registered",
    "has_role",
    "list_counts",
    "balance",
    "token_info",
    "vault_info",
    "owner_of",
    "total_supply",
    "get_metadata",
  ].includes(String(operation));
}

/**
 * Claim message formats. The backend, GM console, and oracle service must all
 * sign exactly these strings for the 2-of-2 multisig to verify on-chain.
 */
export const claimMessages = {
  escrow: (escrowId: string, winnerDid: string) => `claim:${escrowId}:${winnerDid}`,
  hunt: (huntId: string, winnerDid: string) => `claim:${huntId}:${winnerDid}`,
  fundEscrow: (escrowId: string) => `fund:${escrowId}`,
  refundEscrow: (escrowId: string) => `refund:${escrowId}`,
  createHunt: (huntId: string, gmDid: string) => `create:${huntId}:${gmDid}`,
  fundHunt: (huntId: string, gmDid: string) => `fund:${huntId}:${gmDid}`,
  activate: (huntId: string, gmDid: string) => `activate:${huntId}:${gmDid}`,
  pause: (huntId: string, gmDid: string) => `pause:${huntId}:${gmDid}`,
  resume: (huntId: string, gmDid: string) => `resume:${huntId}:${gmDid}`,
  cancel: (huntId: string, gmDid: string) => `cancel:${huntId}:${gmDid}`,
  refundHunt: (huntId: string, gmDid: string) => `refund:${huntId}:${gmDid}`,
  grantRole: (playerDid: string, role: string) => `grant:${playerDid}:${role}`,
  revokeRole: (playerDid: string) => `revoke:${playerDid}`,
};

/**
 * Citizen asset module message formats (citizen-asset.v1). Signed messages
 * for transferable token issuance and vault custody; all mutating messages
 * end with a unique `:ref` so replays are distinguishable.
 */
export const assetMessages = {
  createToken: (tokenId: string, symbol: string, decimals: number) =>
    `create:${tokenId}:${symbol}:${decimals}`,
  mint: (tokenId: string, recipientDid: string, amount: number, ref: string) =>
    `mint:${tokenId}:${recipientDid}:${amount}:${ref}`,
  burn: (tokenId: string, ownerDid: string, amount: number, ref: string) =>
    `burn:${tokenId}:${ownerDid}:${amount}:${ref}`,
  transfer: (tokenId: string, fromDid: string, toDid: string, amount: number, ref: string) =>
    `transfer:${tokenId}:${fromDid}:${toDid}:${amount}:${ref}`,
  openVault: (vaultId: string, tokenId: string, threshold: number, expiryBlock: number) =>
    `vopen:${vaultId}:${tokenId}:${threshold}:${expiryBlock}`,
  vaultTransfer: (vaultId: string, toDid: string, amount: number, ref: string) =>
    `vt:${vaultId}:${toDid}:${amount}:${ref}`,
  /** On-chain account string a depositor transfers vault funds to. */
  vaultAccount: (vaultId: string) => `vault:${vaultId}`,
};
