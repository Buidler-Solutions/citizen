import { claimMessages, didFromPublicKey } from "../../../../chain/sdk/src/index.ts";
import type { Store } from "../store.ts";
import type { ChainModule } from "./chain.module.ts";
import { badRequest } from "../http.ts";

/**
 * Wallet module — DID registration, reward balances, and finality receipts.
 * Replaces the Stellar SDK wallet: identities are Ed25519 keypairs generated
 * on device; the server only ever sees public keys and signatures.
 */

export class WalletModule {
  private readonly chain: ChainModule;
  private readonly store: Store;

  constructor(chain: ChainModule, store: Store) {
    this.chain = chain;
    this.store = store;
  }

  register(input: { did?: string; public_key_hex?: string }) {
    const did = input.did ?? (input.public_key_hex ? didFromPublicKey(input.public_key_hex) : "");
    if (!did.startsWith("did:key:ed25519:")) {
      badRequest("InvalidDid", "expected did:key:ed25519:<public_key_hex>");
    }
    this.store.recordEvent("wallet.registered", "identity.roles", { did });
    this.store.notify(did, "wallet.created", "TreasureNet wallet registered.");
    return { did, registered: true };
  }

  async balance(did: string) {
    if (this.chain.mock) {
      return {
        did,
        token: "CTZN",
        balance: this.chain.mock.getCtznBalance(did),
        source: "mock",
      };
    }
    // Real node: query the configured CTZN reward token module.
    const client = this.chain.config;
    return {
      did,
      token: client.rewardTokenModuleId,
      balance: 0,
      source: "node",
      note: "query /api/v1/ctzn/<module>/balance/<did> on the node",
    };
  }

  receipts(did: string) {
    if (!this.chain.mock) return { did, receipts: [] };
    const receipts = this.chain.mock.listReceipts();
    return {
      did,
      receipts: Object.values(receipts).slice(-20),
    };
  }

  /** Service-signed role grant (admin path after KYC/civic registry check). */
  async grantRole(adminDid: string, playerDid: string, role: string) {
    if (!["player", "gamemaster", "auditor"].includes(role)) {
      badRequest("InvalidRole", "role must be player, gamemaster, or auditor");
    }
    const signature = this.chain.serviceSignature(claimMessages.grantRole(playerDid, role));
    const result = await this.chain.adapter.execute("player-registry.v1", {
      operation: "grant_role",
      admin_did: adminDid,
      signature,
      player_did: playerDid,
      role,
    });
    this.store.recordEvent("role.granted", "identity.roles", { did: playerDid, role });
    this.store.notify(playerDid, "role.granted", `You were granted the ${role} role.`);
    return result.output;
  }

  async revokeRole(adminDid: string, playerDid: string) {
    const signature = this.chain.serviceSignature(claimMessages.revokeRole(playerDid));
    const result = await this.chain.adapter.execute("player-registry.v1", {
      operation: "revoke_role",
      admin_did: adminDid,
      signature,
      player_did: playerDid,
    });
    this.store.recordEvent("role.revoked", "identity.roles", { did: playerDid });
    this.store.notify(playerDid, "role.revoked", "Your role was revoked.");
    return result.output;
  }

  async roleOf(did: string) {
    return this.chain.adapter.execute("player-registry.v1", { operation: "role_of", did });
  }

  async isRegistered(did: string) {
    return this.chain.adapter.execute("player-registry.v1", { operation: "is_registered", did });
  }
}
