import {
  CitizenNodeClient,
  MockChain,
  ModuleGateway,
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
      const client = new CitizenNodeClient(config.nodeUrl);
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
    this.bootstrapped = true;
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

  /**
   * CTZN reward distribution after an escrow payout. Node mode executes a
   * mint on the configured reward token module signed by the service and
   * oracle keys (the issuers configured at deploy time); mock mode credits
   * the balance inside the escrow claim already, so this is a no-op there
   * (single payout authority).
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
