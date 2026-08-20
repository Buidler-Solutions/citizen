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
    this.store.touchWallet(did);
    if (this.chain.mock) {
      return {
        did,
        token: "CTZN",
        balance: this.chain.mock.getCtznBalance(did),
        source: "mock",
      };
    }
    // Node mode: CTZN rewards are soulbound tokens minted per won hunt, so
    // the balance is the number of reward tokens the player still owns.
    // Read owner_of for each minted reward token of this winner's confirmed
    // claims; fall back to the projection when the node is unreachable.
    const tokenIds = [...this.store.claims.values()]
      .filter((claim) => claim.winner_did === did && claim.status === "confirmed")
      .map((claim) => `reward-${claim.hunt_id}`);
    let owned = 0;
    let source = "node";
    let note: string | undefined;
    try {
      for (const tokenId of tokenIds) {
        const result = await this.chain.adapter.execute(
          this.chain.config.rewardTokenModuleId,
          { operation: "owner_of", token_id: tokenId }
        );
        const owner = result.output.owner as string | undefined;
        const burned = result.output.burned as boolean | undefined;
        if (owner === did && !burned) owned += 1;
      }
    } catch {
      owned = tokenIds.length;
      source = "projection";
      note = "reward token module unreachable; balance from local projection";
    }
    return {
      did,
      token: this.chain.config.rewardTokenModuleId,
      balance: owned,
      tokens: tokenIds.length,
      source,
      ...(note ? { note } : {}),
    };
  }

  async receipts(did: string) {
    if (this.chain.mock) {
      const receipts = this.chain.mock.listReceipts();
      return {
        did,
        receipts: Object.values(receipts).slice(-20),
      };
    }
    // Node mode: fetch finality receipts for this player's confirmed claims;
    // claims without a receipt id surface as pending entries.
    const claims = [...this.store.claims.values()]
      .filter((claim) => claim.winner_did === did)
      .slice(-20);
    const client = this.chain.nodeClient;
    const receipts = await Promise.all(
      claims.map(async (claim) => {
        if (claim.receipt_id && client && !claim.receipt_id.startsWith("node:")) {
          try {
            const chainReceipt = await client.getReceipt(claim.receipt_id);
            return { claim_id: claim.claim_id, hunt_id: claim.hunt_id, status: claim.status, chain_receipt: chainReceipt };
          } catch {
            // fall through to the projection summary below
          }
        }
        return {
          claim_id: claim.claim_id,
          hunt_id: claim.hunt_id,
          status: claim.status,
          receipt_id: claim.receipt_id,
          block_height: claim.block_height,
        };
      })
    );
    return { did, receipts };
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
