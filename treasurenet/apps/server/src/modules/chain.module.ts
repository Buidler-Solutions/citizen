import {
  CitizenNodeClient,
  MockChain,
  ModuleGateway,
  assetMessages,
  claimMessages,
  signMessage,
  didFromPrivateKeyHex,
  type ChainAdapter,
} from "../../../../chain/sdk/src/index.ts";
import type { ServerConfig } from "../config.ts";
import type { PersistenceModule } from "./persistence.module.ts";

/**
 * Chain module: the single place where the backend touches the Citizen
 * chain. Chooses the real node adapter (TREASURENET_NODE_URL) or the
 * deterministic in-memory mock for offline development and CI.
 *
 * The service DID sponsors all player actions via builder credits, so
 * players never need to hold tokens to play.
 */

const GOVERNANCE_PROPOSALS = {
  escrow: "proposal-approved-treasurenet-escrow",
  hunt: "proposal-approved-treasurenet-hunt",
  registry: "proposal-approved-treasurenet-registry",
  asset: "proposal-approved-treasurenet-asset",
};

export class ChainModule {
  readonly adapter: ChainAdapter;
  readonly mock?: MockChain;
  readonly nodeClient?: CitizenNodeClient;
  private bootstrapped = false;
  private readonly bootHeightBase: number;
  private readonly bootTime = Date.now();
  private gateway?: ModuleGateway;
  /** Latest node height (node mode); seeded at bootstrap and refreshed by the indexer. */
  private heightHint = 0;

  readonly config: ServerConfig;

  constructor(config: ServerConfig, persistence?: PersistenceModule) {
    this.config = config;
    if (config.nodeUrl) {
      const client = new CitizenNodeClient(config.nodeUrl, config.nodeApiKey);
      const queueStore = persistence
        ? {
            enqueue: (item: { moduleId: string; operation: string; params: Record<string, unknown>; attempts: number }) => persistence.enqueueRetry(item),
            dequeue: (id: string) => persistence.dequeueRetry(id),
            bumpAttempts: (id: string, attempts: number) => persistence.bumpRetryAttempts(id, attempts),
            load: () => persistence.loadRetryQueue(),
          }
        : undefined;
      const gateway = new ModuleGateway(client, undefined, queueStore);
      this.gateway = gateway;
      this.adapter = gateway;
      this.nodeClient = client;
    } else {
      const mock = new MockChain();
      this.adapter = mock;
      this.mock = mock;
    }
    this.bootHeightBase = 100;
  }

  /** Restore persisted retry-queue items into the gateway (node mode). */
  async restoreRetryQueue(): Promise<number> {
    return this.gateway ? this.gateway.restoreRetryQueue() : 0;
  }

  async flushRetryQueue() {
    return this.gateway ? this.gateway.flushRetryQueue() : [];
  }

  pendingRetries(): number {
    return this.gateway ? this.gateway.pendingRetries() : 0;
  }

  /** Configure the three modules. Idempotent: reconfiguration is a no-op. */
  async bootstrap(): Promise<void> {
    if (this.bootstrapped) return;
    const { config } = this;
    // Reconfiguration after the governance-approved bootstrap requires the
    // admin signature over `configure:<oracles>` (modules verify the same
    // message shape in mock and WASM runtimes).
    await this.adapter.execute("player-registry.v1", {
      operation: "configure",
      admin_did: config.serviceDid,
      proposal_id: GOVERNANCE_PROPOSALS.registry,
      admin_sig: this.serviceSignature("configure:player-registry"),
    });
    await this.adapter.execute("treasure-hunt.v1", {
      operation: "configure",
      admin_did: config.serviceDid,
      oracles: config.oracleDid,
      proposal_id: GOVERNANCE_PROPOSALS.hunt,
      admin_sig: this.serviceSignature(`configure:${config.oracleDid}`),
    });
    await this.adapter.execute("treasure-escrow.v1", {
      operation: "configure",
      admin_did: config.serviceDid,
      oracles: config.oracleDid,
      proposal_id: GOVERNANCE_PROPOSALS.escrow,
      admin_sig: this.serviceSignature(`configure:${config.oracleDid}`),
    });
    const assetIssuers = `${config.serviceDid},${config.oracleDid}`;
    await this.adapter.execute(this.config.assetModuleId, {
      operation: "configure",
      admin_did: config.serviceDid,
      issuers: assetIssuers,
      threshold: "2",
      proposal_id: GOVERNANCE_PROPOSALS.asset,
      // Reconfiguration after the deploy-time governance bootstrap requires
      // the admin signature over `configure:<issuers>:<threshold>`.
      admin_sig: this.serviceSignature(`configure:${assetIssuers}:2`),
    });
    await this.ensureRewardAsset();
    this.bootstrapped = true;
  }

  /**
   * Create the default reward asset (issuer-threshold signed). Idempotent:
   * TokenExists or a replayed scope means a previous boot already created it.
   */
  private async ensureRewardAsset(): Promise<void> {
    const token = this.config.rewardAssetId;
    const message = assetMessages.createToken(token, "TNG", 2);
    try {
      await this.adapter.execute(this.config.assetModuleId, {
        operation: "create_token",
        token_id: token,
        symbol: "TNG",
        decimals: "2",
        issuer_dids: `${this.config.serviceDid},${this.config.oracleDid}`,
        signatures: `${this.serviceSignature(message)},${signMessage(message, this.config.oracleKeyHex)}`,
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "TokenExists" && code !== "ReplayedSubmission") throw error;
    }
  }

  /** Oracle co-signature for a 2-of-2 claim envelope. */
  signOracleClaim(kind: "escrow" | "hunt", id: string, winnerDid: string): string {
    const message =
      kind === "escrow"
        ? claimMessages.escrow(id, winnerDid)
        : claimMessages.hunt(id, winnerDid);
    return signMessage(message, this.config.oracleKeyHex);
  }

  serviceSignature(message: string): string {
    return signMessage(message, this.config.serviceKeyHex);
  }

  /** Oracle co-signature over an asset module message (vault payout). */
  oracleAssetSignature(message: string): string {
    return signMessage(message, this.config.oracleKeyHex);
  }

  /**
   * Reward custody on the citizen-asset module. Hunts no longer settle via
   * soulbound CTZN mints: issuers mint transferable reward tokens to the GM,
   * the GM deposits them into a timed 2-of-2 vault (GM + oracle, fallback
   * GM after the escrow deadline), and payouts/refunds move real balances.
   */
  async mintRewardToOwner(ownerDid: string, amount: number, ref: string): Promise<boolean> {
    const message = assetMessages.mint(this.config.rewardAssetId, ownerDid, amount, ref);
    const result = await this.adapter.execute(this.config.assetModuleId, {
      operation: "mint",
      token_id: this.config.rewardAssetId,
      recipient_did: ownerDid,
      amount: String(amount),
      ref,
      issuer_dids: `${this.config.serviceDid},${this.config.oracleDid}`,
      signatures: `${this.serviceSignature(message)},${this.oracleAssetSignature(message)}`,
    });
    return Boolean(result.output.ok);
  }

  async openRewardVault(
    vaultId: string,
    ownerDid: string,
    deadlineBlock: number,
    opts?: { instantClaim?: boolean }
  ): Promise<string> {
    const threshold = 2;
    // Instant-claim hunts add the service DID as an approver so delegated
    // payouts (service + oracle) reach the 2-of-2 threshold; manual claims
    // still settle with GM + oracle.
    const approvers = opts?.instantClaim
      ? `${ownerDid},${this.config.serviceDid},${this.config.oracleDid}`
      : `${ownerDid},${this.config.oracleDid}`;
    const message = assetMessages.openVault(vaultId, this.config.rewardAssetId, threshold, deadlineBlock);
    const result = await this.adapter.execute(this.config.assetModuleId, {
      operation: "open_vault",
      vault_id: vaultId,
      token_id: this.config.rewardAssetId,
      approver_dids: approvers,
      threshold: String(threshold),
      expiry_block: String(deadlineBlock),
      fallback_owner_did: ownerDid,
      admin_did: this.config.serviceDid,
      admin_sig: this.serviceSignature(message),
    });
    if (!result.output.ok) return "";
    return assetMessages.vaultAccount(vaultId);
  }

  /** 2-of-2 vault payout (GM + oracle) to the hunt winner. */
  async vaultPayout(
    vaultId: string,
    winnerDid: string,
    amount: number,
    ref: string,
    gmDid: string,
    gmSignature: string
  ): Promise<boolean> {
    const message = assetMessages.vaultTransfer(vaultId, winnerDid, amount, ref);
    const result = await this.adapter.execute(this.config.assetModuleId, {
      operation: "vault_transfer",
      vault_id: vaultId,
      token_id: this.config.rewardAssetId,
      to_did: winnerDid,
      amount: String(amount),
      ref,
      cosigner_dids: `${gmDid},${this.config.oracleDid}`,
      signatures: `${gmSignature},${this.oracleAssetSignature(message)}`,
    });
    return Boolean(result.output.ok);
  }

  /** Delegated 2-of-2 vault payout (service + oracle) for instant claims. */
  async vaultPayoutDelegated(
    vaultId: string,
    winnerDid: string,
    amount: number,
    ref: string
  ): Promise<boolean> {
    const message = assetMessages.vaultTransfer(vaultId, winnerDid, amount, ref);
    const result = await this.adapter.execute(this.config.assetModuleId, {
      operation: "vault_transfer",
      vault_id: vaultId,
      token_id: this.config.rewardAssetId,
      to_did: winnerDid,
      amount: String(amount),
      ref,
      cosigner_dids: `${this.config.serviceDid},${this.config.oracleDid}`,
      signatures: `${this.serviceSignature(message)},${this.oracleAssetSignature(message)}`,
    });
    return Boolean(result.output.ok);
  }

  /** Post-expiry vault refund to the fallback owner (GM signature only). */
  async vaultRefund(
    vaultId: string,
    ownerDid: string,
    amount: number,
    ref: string,
    ownerSignature: string
  ): Promise<boolean> {
    const message = assetMessages.vaultTransfer(vaultId, ownerDid, amount, ref);
    const result = await this.adapter.execute(this.config.assetModuleId, {
      operation: "vault_transfer",
      vault_id: vaultId,
      token_id: this.config.rewardAssetId,
      to_did: ownerDid,
      amount: String(amount),
      ref,
      cosigner_dids: ownerDid,
      signatures: ownerSignature,
    });
    return Boolean(result.output.ok);
  }

  /** Balance of the default reward asset for a DID (mock and node). */
  async assetBalance(did: string): Promise<number> {
    const result = await this.adapter.execute(this.config.assetModuleId, {
      operation: "balance",
      token_id: this.config.rewardAssetId,
      did,
    });
    return Number(result.output.balance ?? 0);
  }

  /**
   * Reward token module kept for soulbound CTZN identity surfaces; hunt
   * payouts settle through the transferable asset vault instead.
   */
  async distributeReward(winnerDid: string, amount: number, huntId: string): Promise<boolean> {
    if (!this.nodeClient || !this.config.rewardDistribute) return false;
    const tokenMessage = `mint:reward-${huntId}:${winnerDid}`;
    const issuers = `${this.config.serviceDid},${this.config.oracleDid}`;
    const signatures = `${this.serviceSignature(tokenMessage)},${signMessage(tokenMessage, this.config.oracleKeyHex)}`;
    const result = await this.adapter.execute(this.config.rewardTokenModuleId, {
      operation: "mint",
      token_id: `reward-${huntId}`,
      issuer_dids: issuers,
      signatures,
      recipient_did: winnerDid,
      metadata: JSON.stringify({ source: "treasurenet-escrow", hunt_id: huntId, amount }),
    });
    return Boolean(result.output.ok);
  }

  /** Seed the height hint from the node so expiry blocks are realistic. */
  async refreshHeight(): Promise<void> {
    if (!this.nodeClient) return;
    try {
      const blocks = (await this.nodeClient.listBlocks()) as { items?: Array<{ height?: number }> };
      const newest = Math.max(0, ...(blocks.items ?? []).map((item) => Number(item.height ?? 0)));
      if (newest > 0) this.heightHint = newest;
    } catch {
      // Node unreachable: the retry queue will surface it; keep the last hint.
    }
  }

  setHeightHint(height: number) {
    if (height > this.heightHint) this.heightHint = height;
  }

  /**
   * Wall-clock block estimate for the scheduler. Mock mode advances at the
   * configured cadence; node mode tracks the real ledger height (seeded at
   * bootstrap, refreshed by the indexer poll).
   */
  currentBlock(): number {
    if (this.mock) {
      const elapsed = Math.floor((Date.now() - this.bootTime) / 1000);
      const height = this.bootHeightBase + elapsed * this.config.blockCadencePerSecond;
      this.mock.setBlockHeight(height);
      return height;
    }
    return this.heightHint > 0 ? this.heightHint : this.bootHeightBase;
  }

  /** DID derived from the configured GM refund key, if any. */
  gmRefundDid(): string | undefined {
    return this.config.gmRefundKeyHex
      ? didFromPrivateKeyHex(this.config.gmRefundKeyHex)
      : undefined;
  }

  mode(): "node" | "mock" {
    return this.config.nodeUrl ? "node" : "mock";
  }
}

export { GOVERNANCE_PROPOSALS };
