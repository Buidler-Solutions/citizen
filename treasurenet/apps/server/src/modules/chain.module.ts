import {
  CitizenNodeClient,
  MockChain,
  ModuleGateway,
  claimMessages,
  signMessage,
  type ChainAdapter,
} from "../../../../chain/sdk/src/index.ts";
import type { ServerConfig } from "../config.ts";

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
  private bootstrapped = false;
  private readonly bootHeightBase: number;
  private readonly bootTime = Date.now();

  readonly config: ServerConfig;

  constructor(config: ServerConfig) {
    this.config = config;
    if (config.nodeUrl) {
      this.adapter = new ModuleGateway(new CitizenNodeClient(config.nodeUrl));
    } else {
      const mock = new MockChain();
      this.adapter = mock;
      this.mock = mock;
    }
    this.bootHeightBase = 100;
  }

  /** Configure the three modules. Idempotent: reconfiguration is a no-op. */
  async bootstrap(): Promise<void> {
    if (this.bootstrapped) return;
    const { config } = this;
    await this.adapter.execute("player-registry.v1", {
      operation: "configure",
      admin_did: config.serviceDid,
      proposal_id: GOVERNANCE_PROPOSALS.registry,
    });
    await this.adapter.execute("treasure-hunt.v1", {
      operation: "configure",
      admin_did: config.serviceDid,
      oracles: config.oracleDid,
      proposal_id: GOVERNANCE_PROPOSALS.hunt,
    });
    await this.adapter.execute("treasure-escrow.v1", {
      operation: "configure",
      admin_did: config.serviceDid,
      oracles: config.oracleDid,
      proposal_id: GOVERNANCE_PROPOSALS.escrow,
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
   * Wall-clock block estimate for the scheduler. With the mock chain the
   * block advances at the configured cadence; against a real node the
   * ledger height is authoritative (queried by the indexer).
   */
  currentBlock(): number {
    if (this.mock) {
      const elapsed = Math.floor((Date.now() - this.bootTime) / 1000);
      return this.bootHeightBase + elapsed * this.config.blockCadencePerSecond;
    }
    return this.bootHeightBase;
  }

  mode(): "node" | "mock" {
    return this.config.nodeUrl ? "node" : "mock";
  }
}

export { GOVERNANCE_PROPOSALS };
