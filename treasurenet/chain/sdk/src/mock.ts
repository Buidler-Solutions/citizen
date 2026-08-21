import { verifyMessage, didFromPublicKey } from "./keys.ts";
import type { ChainAdapter, ChainWriteMeta } from "./modules.ts";
import { MODULES, assetMessages } from "./modules.ts";

/**
 * In-memory mock of the Citizen chain for offline development, CI, and
 * smoke tests. Mirrors the exact state machines and error codes of the
 * treasure-escrow / treasure-hunt / player-registry / citizen-asset WASM
 * modules plus finality receipts and reward balances.
 *
 * Switch to the real node by constructing ModuleGateway(CitizenNodeClient(...)).
 */

interface EscrowState {
  owner: string;
  claimer: string;
  amount: number;
  token: string;
  deadline: number;
  status: "created" | "funded" | "completed" | "refunded";
  winner?: string;
  delegate?: string;
  receiptBlock: number;
}

interface HuntState {
  gm: string;
  reward: number;
  token: string;
  expires: number;
  escrow?: string;
  status: "created" | "funded" | "active" | "paused" | "completed" | "refunded" | "cancelled";
  winner?: string;
  claimed?: boolean;
  delegate?: string;
  receiptBlock: number;
}

interface RegistryState {
  admin: string;
  roles: Map<string, { role: string; revoked: boolean }>;
  counts: Map<string, number>;
}

interface AssetToken {
  symbol: string;
  decimals: number;
  supply: number;
  balances: Map<string, number>;
}

interface AssetVault {
  token: string;
  approvers: string[];
  threshold: number;
  expiryBlock: number;
  fallbackOwner: string;
}

export class MockChain implements ChainAdapter {
  private blockHeight = 100;
  private readonly escrows = new Map<string, EscrowState>();
  private readonly hunts = new Map<string, HuntState>();
  private readonly registries = new Map<string, RegistryState>();
  private readonly payouts = new Map<string, string>();
  private readonly receipts = new Map<string, Record<string, unknown>>();
  private readonly writeScopes = new Set<string>();
  private assetConfig: { admin: string; issuers: string[]; threshold: number } | undefined;
  private readonly assetTokens = new Map<string, AssetToken>();
  private readonly assetVaults = new Map<string, AssetVault>();

  setBlockHeight(height: number) {
    this.blockHeight = height;
  }

  currentBlock(): number {
    return this.blockHeight;
  }

  getReceipt(receiptId: string) {
    return this.receipts.get(receiptId);
  }

  listReceipts(): Record<string, Record<string, unknown>> {
    return Object.fromEntries(this.receipts);
  }

  private receipt(meta: Partial<ChainWriteMeta> & { key: string }): ChainWriteMeta & { receipt_id: string } {
    const receiptId = `rcpt-${meta.key}-${this.blockHeight}-${this.receipts.size + 1}`;
    this.receipts.set(receiptId, {
      receipt_id: receiptId,
      block_height: this.blockHeight,
      commit_proof: `proof:${receiptId}`,
      final: true,
      ...(meta.receipt_block !== undefined ? { state_block: meta.receipt_block } : {}),
    });
    return {
      module_id: meta.module_id ?? "",
      gas_consumed: meta.gas_consumed ?? 0,
      receipt_block: this.blockHeight,
      receipt_id: receiptId,
    };
  }

  private ok(output: Record<string, unknown>, key: string) {
    return {
      output: { ok: true, receipt_block: this.blockHeight, ...output },
      meta: this.receipt({ key, gas_consumed: 1000, receipt_block: this.blockHeight }),
    };
  }

  private fail(code: string): never {
    const error = new Error(`rejected: ${code}`);
    (error as Error & { code?: string }).code = code;
    throw error;
  }

  private verify(did: string, message: string, signature: string): boolean {
    const publicKeyHex = did.split(":").pop() ?? "";
    return verifyMessage(message, signature, publicKeyHex);
  }

  private ensureGovernanceApproved(proposalId: string | undefined, what: string) {
    if (!proposalId || !proposalId.startsWith("proposal-approved")) {
      this.fail(`governance has not approved this ${what} configuration`);
    }
  }

  async execute(
    moduleId: string,
    params: Record<string, unknown>
  ): Promise<{ output: Record<string, unknown>; meta: ChainWriteMeta }> {
    const operation = String(params.operation ?? "");
    const scope = `${moduleId}:${operation}:${
      params.escrow_id ?? params.hunt_id ?? params.vault_id ?? params.ref ?? params.token_id ?? params.player_did ?? params.did ?? ""
    }`;
    const isWrite = ![
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
    ].includes(operation);
    // Idempotency matches the real ModuleGateway: a scope is replayed only
    // after a successful write; rejected executions stay retryable.
    if (isWrite && this.writeScopes.has(scope)) {
      this.fail("ReplayedSubmission");
    }
    const result = this.dispatch(moduleId, operation, params);
    if (isWrite) {
      this.writeScopes.add(scope);
    }
    return result;
  }

  private dispatch(
    moduleId: string,
    operation: string,
    params: Record<string, unknown>
  ): { output: Record<string, unknown>; meta: ChainWriteMeta } {
    if (moduleId === MODULES.escrow) return this.escrow(operation, params);
    if (moduleId === MODULES.hunt) return this.hunt(operation, params);
    if (moduleId === MODULES.registry) return this.registry(operation, params);
    if (moduleId === MODULES.asset) return this.asset(operation, params);
    this.fail("unknown module");
  }

  private escrow(operation: string, p: Record<string, unknown>) {
    const id = String(p.escrow_id ?? "");
    const state = this.escrows.get(id);

    switch (operation) {
      case "configure": {
        const admin = String(p.admin_did ?? "");
        if (!admin) this.fail("missing required fields: admin_did");
        const existing = this.registries.get("escrow-config");
        if (!existing) {
          this.ensureGovernanceApproved(String(p.proposal_id ?? ""), "escrow");
          this.registries.set("escrow-config", { admin, roles: new Map(), counts: new Map() });
        } else if (!this.verify(existing.admin, `configure:${p.oracles ?? ""}`, String(p.admin_sig ?? ""))) {
          this.fail("admin signature verification failed");
        }
        if (p.oracles) this.registries.get("escrow-config")!.roles.set("oracles", { role: String(p.oracles), revoked: false });
        return this.ok({ admin }, `escrow-configure`);
      }
      case "init": {
        const escrowId = String(p.escrow_id ?? "");
        const ownerDid = String(p.owner_did ?? "");
        const claimerDid = String(p.claimer_did ?? "");
        if (!escrowId || !ownerDid || !claimerDid) {
          this.fail("missing required fields: escrow_id, owner_did, claimer_did");
        }
        const amount = Number(p.amount ?? 0);
        const deadline = Number(p.deadline_block ?? 0);
        if (amount <= 0) this.fail("InvalidAmount");
        if (deadline <= 0) this.fail("InvalidDeadline");
        if (state) this.fail("AlreadyInitialized");
        this.escrows.set(id, {
          owner: ownerDid,
          claimer: claimerDid,
          amount,
          token: String(p.token ?? "CTZN"),
          deadline,
          status: "created",
          receiptBlock: this.blockHeight,
        });
        return this.ok({ escrow_id: id, status: "created", amount, deadline_block: deadline }, `escrow-init-${id}`);
      }
      case "fund": {
        if (!state) this.fail("Uninitialized");
        if (state.status !== "created") this.fail("AlreadyFunded");
        if (p.funder_did !== state.owner) this.fail("NotOwner");
        if (!p.signature) this.fail("SignatureRequired");
        if (!this.verify(state.owner, `fund:${id}`, String(p.signature))) this.fail("NotOwner");
        state.status = "funded";
        state.receiptBlock = this.blockHeight;
        return this.ok({ escrow_id: id, status: "funded", amount: state.amount }, `escrow-fund-${id}`);
      }
      case "claim": {
        if (!state) this.fail("Uninitialized");
        const winner = String(p.winner_did ?? "");
        if (state.status === "completed") this.fail("AlreadyClaimed");
        if (state.status !== "funded") this.fail("NotActive");
        if (this.blockHeight > state.deadline) this.fail("Expired");
        const oracles = (this.registries.get("escrow-config")?.roles.get("oracles")?.role ?? "").split(",").filter(Boolean);
        const dids = String(p.cosigner_dids ?? "").split(",");
        const sigs = String(p.signatures ?? "").split(",");
        const message = `claim:${id}:${winner}`;
        let ownerSigned = false;
        let oracleSigned = false;
        for (let i = 0; i < Math.min(dids.length, sigs.length); i++) {
          if (!dids[i] || !sigs[i]) continue;
          if (!this.verify(dids[i], message, sigs[i])) continue;
          if (dids[i] === state.owner) ownerSigned = true;
          if (state.delegate && dids[i] === state.delegate) ownerSigned = true;
          if (oracles.includes(dids[i])) oracleSigned = true;
        }
        if (!ownerSigned) this.fail("NotOwner");
        if (!oracleSigned) this.fail("OracleSignatureRequired");
        state.status = "completed";
        state.winner = winner;
        state.receiptBlock = this.blockHeight;
        this.payouts.set(id, `${winner}:${state.amount}:${this.blockHeight}`);
        return this.ok(
          { escrow_id: id, status: "completed", winner, payout: state.amount, token: state.token },
          `escrow-claim-${id}`
        );
      }
      case "refund": {
        if (!state) this.fail("Uninitialized");
        if (p.owner_did !== state.owner) this.fail("NotOwner");
        if (state.status === "completed" || state.status === "refunded") this.fail("NotActive");
        if (this.blockHeight <= state.deadline) this.fail("NotExpired");
        if (!p.signature) this.fail("SignatureRequired");
        if (!this.verify(state.owner, `refund:${id}`, String(p.signature))) this.fail("NotOwner");
        state.status = "refunded";
        state.receiptBlock = this.blockHeight;
        return this.ok({ escrow_id: id, status: "refunded", refund: state.amount }, `escrow-refund-${id}`);
      }
      case "set_claim_delegate": {
        if (!state) this.fail("Uninitialized");
        const gm = String(p.gm_did ?? "");
        const delegateDid = String(p.delegate_did ?? "");
        if (gm !== state.owner) this.fail("NotOwner");
        if (!delegateDid) this.fail("missing required fields: escrow_id, gm_did, delegate_did");
        if (!p.signature) this.fail("SignatureRequired");
        if (!this.verify(gm, `delegate:${id}:${delegateDid}`, String(p.signature))) this.fail("NotOwner");
        state.delegate = delegateDid;
        return this.ok({ escrow_id: id, delegate: delegateDid }, `escrow-delegate-${id}`);
      }
      case "is_expired": {
        if (!state) this.fail("Uninitialized");
        return this.ok({ expired: this.blockHeight > state.deadline }, `escrow-exp-${id}`);
      }
      case "get_status": {
        if (!state) this.fail("Uninitialized");
        const expired = this.blockHeight > state.deadline;
        const status = expired && (state.status === "created" || state.status === "funded")
          ? "Expired"
          : state.status === "created" ? "Created"
          : state.status === "funded" ? "Active"
          : state.status === "completed" ? "Completed"
          : "Refunded";
        return this.ok({ status }, `escrow-status-${id}`);
      }
      case "get_reward": {
        if (!state) this.fail("Uninitialized");
        return this.ok({ amount: state.amount, token: state.token }, `escrow-reward-${id}`);
      }
      default:
        this.fail("unknown operation");
    }
  }

  private hunt(operation: string, p: Record<string, unknown>) {
    const id = String(p.hunt_id ?? "");
    const state = this.hunts.get(id);

    switch (operation) {
      case "configure": {
        const admin = String(p.admin_did ?? "");
        if (!admin) this.fail("missing required fields: admin_did");
        const existing = this.registries.get("hunt-config");
        if (!existing) {
          this.ensureGovernanceApproved(String(p.proposal_id ?? ""), "hunt module");
          this.registries.set("hunt-config", { admin, roles: new Map(), counts: new Map() });
        } else if (!this.verify(existing.admin, `configure:${p.oracles ?? ""}`, String(p.admin_sig ?? ""))) {
          this.fail("Unauthorized");
        }
        if (p.oracles) this.registries.get("hunt-config")!.roles.set("oracles", { role: String(p.oracles), revoked: false });
        return this.ok({ admin }, "hunt-configure");
      }
      case "create_hunt": {
        const reward = Number(p.reward_amount ?? 0);
        const expires = Number(p.expires_block ?? 0);
        if (reward <= 0) this.fail("InvalidAmount");
        if (expires <= this.blockHeight) this.fail("InvalidStatus");
        if (state) this.fail("AlreadyExists");
        const gm = String(p.gm_did ?? "");
        if (!p.signature) this.fail("SignatureRequired");
        if (!this.verify(gm, `create:${id}:${gm}`, String(p.signature))) this.fail("NotOwner");
        this.hunts.set(id, {
          gm,
          reward,
          token: String(p.reward_token ?? "CTZN"),
          expires,
          ...(p.escrow_id ? { escrow: String(p.escrow_id) } : {}),
          status: "created",
          receiptBlock: this.blockHeight,
        });
        return this.ok({ hunt_id: id, status: "Created", reward, expires_block: expires }, `hunt-create-${id}`);
      }
      case "fund_hunt": {
        if (!state) this.fail("NotFound");
        if (state.status !== "created") this.fail("AlreadyFunded");
        if (p.funder_did !== state.gm) this.fail("NotOwner");
        const amount = Number(p.amount ?? 0);
        if (amount < state.reward) this.fail("InsufficientFunds");
        if (!p.signature) this.fail("SignatureRequired");
        if (!this.verify(state.gm, `fund:${id}:${state.gm}`, String(p.signature))) this.fail("NotOwner");
        state.status = "funded";
        state.receiptBlock = this.blockHeight;
        return this.ok({ hunt_id: id, status: "Funded", funded: amount }, `hunt-fund-${id}`);
      }
      case "activate":
      case "pause":
      case "resume":
      case "cancel": {
        if (!state) this.fail("NotFound");
        const gm = String(p.gm_did ?? "");
        if (gm !== state.gm) this.fail("NotOwner");
        if (!p.signature) this.fail("NotOwner");
        if (!this.verify(gm, `${operation}:${id}:${gm}`, String(p.signature))) this.fail("NotOwner");
        if (operation === "activate") {
          if (state.status === "active") this.fail("AlreadyActive");
          if (state.status !== "funded") this.fail("InvalidStatus");
          state.status = "active";
        } else if (operation === "pause") {
          if (state.status === "paused") this.fail("AlreadyPaused");
          if (state.status !== "active") this.fail("NotActive");
          state.status = "paused";
        } else if (operation === "resume") {
          if (state.status !== "paused") this.fail("NotPaused");
          state.status = "active";
        } else {
          if (state.status !== "created" && state.status !== "funded") this.fail("CannotCancel");
          state.status = "cancelled";
        }
        state.receiptBlock = this.blockHeight;
        const label = state.status.charAt(0).toUpperCase() + state.status.slice(1);
        return this.ok({ hunt_id: id, status: label }, `hunt-${operation}-${id}`);
      }
      case "claim": {
        if (!state) this.fail("NotFound");
        const winner = String(p.winner_did ?? "");
        if (state.claimed || state.status === "completed") this.fail("AlreadyClaimed");
        if (state.status !== "active") this.fail("NotActive");
        if (this.blockHeight > state.expires) this.fail("Expired");
        const oracles = (this.registries.get("hunt-config")?.roles.get("oracles")?.role ?? "").split(",").filter(Boolean);
        const dids = String(p.cosigner_dids ?? "").split(",");
        const sigs = String(p.signatures ?? "").split(",");
        const message = `claim:${id}:${winner}`;
        let gmSigned = false;
        let oracleSigned = false;
        for (let i = 0; i < Math.min(dids.length, sigs.length); i++) {
          if (!dids[i] || !sigs[i]) continue;
          if (!this.verify(dids[i], message, sigs[i])) continue;
          if (dids[i] === state.gm) gmSigned = true;
          if (state.delegate && dids[i] === state.delegate) gmSigned = true;
          if (oracles.includes(dids[i])) oracleSigned = true;
        }
        if (!gmSigned) this.fail("NotOwner");
        if (!oracleSigned) this.fail("OracleSignatureRequired");
        state.status = "completed";
        state.winner = winner;
        state.claimed = true;
        state.receiptBlock = this.blockHeight;
        this.payouts.set(id, `${winner}:${state.reward}:${this.blockHeight}`);
        return this.ok({ hunt_id: id, status: "Completed", winner, payout: state.reward }, `hunt-claim-${id}`);
      }
      case "refund": {
        if (!state) this.fail("NotFound");
        const gm = String(p.gm_did ?? "");
        if (gm !== state.gm) this.fail("NotOwner");
        if (state.status === "completed") this.fail("AlreadyClaimed");
        if (state.status === "cancelled" || state.status === "refunded") this.fail("InvalidStatus");
        if (state.status === "created") this.fail("NotActive");
        if (this.blockHeight <= state.expires) this.fail("NotExpired");
        if (!p.signature) this.fail("NotOwner");
        if (!this.verify(gm, `refund:${id}:${gm}`, String(p.signature))) this.fail("NotOwner");
        state.status = "refunded";
        state.receiptBlock = this.blockHeight;
        return this.ok({ hunt_id: id, status: "Refunded", refund: state.reward }, `hunt-refund-${id}`);
      }
      case "set_claim_delegate": {
        if (!state) this.fail("NotFound");
        const gm = String(p.gm_did ?? "");
        const delegateDid = String(p.delegate_did ?? "");
        if (gm !== state.gm) this.fail("NotOwner");
        if (!delegateDid) this.fail("missing required fields: hunt_id, gm_did, delegate_did");
        if (!p.signature) this.fail("SignatureRequired");
        if (!this.verify(gm, `delegate:${id}:${delegateDid}`, String(p.signature))) this.fail("NotOwner");
        state.delegate = delegateDid;
        return this.ok({ hunt_id: id, delegate: delegateDid }, `hunt-delegate-${id}`);
      }
      case "get_hunt": {
        if (!state) this.fail("NotFound");
        const expired = this.blockHeight > state.expires && ["created", "funded", "active", "paused"].includes(state.status);
        const status = expired ? "Expired"
          : { created: "Created", funded: "Funded", active: "Active", paused: "Paused", completed: "Completed", refunded: "Refunded", cancelled: "Cancelled" }[state.status];
        return this.ok(
          {
            hunt_id: id,
            status,
            gm: state.gm,
            reward: state.reward,
            token: state.token,
            expires_block: state.expires,
            escrow_id: state.escrow ?? "",
            winner: state.winner ?? "",
          },
          `hunt-get-${id}`
        );
      }
      default:
        this.fail("unknown operation");
    }
  }

  private registry(operation: string, p: Record<string, unknown>) {
    const registry = this.registries.get("player-registry");

    switch (operation) {
      case "configure": {
        const admin = String(p.admin_did ?? "");
        if (!admin) this.fail("missing required fields: admin_did");
        if (!registry) {
          this.ensureGovernanceApproved(String(p.proposal_id ?? ""), "registry");
          this.registries.set("player-registry", { admin, roles: new Map(), counts: new Map() });
          return this.ok({ admin }, "registry-configure");
        }
        if (p.admin_did !== registry.admin) this.fail("Unauthorized");
        if (!this.verify(registry.admin, "configure:player-registry", String(p.admin_sig ?? ""))) this.fail("Unauthorized");
        return this.ok({ admin }, "registry-configure");
      }
      case "grant_role": {
        if (!registry) this.fail("Unauthorized");
        const player = String(p.player_did ?? "");
        const role = String(p.role ?? "").toLowerCase();
        if (!["player", "gamemaster", "auditor"].includes(role)) this.fail("InvalidRole");
        if (p.admin_did !== registry.admin) this.fail("Unauthorized");
        if (!this.verify(registry.admin, `grant:${player}:${role}`, String(p.signature ?? ""))) this.fail("Unauthorized");
        if (registry.roles.has(player)) this.fail("AlreadyRegistered");
        registry.roles.set(player, { role, revoked: false });
        registry.counts.set("total", (registry.counts.get("total") ?? 0) + 1);
        registry.counts.set(role, (registry.counts.get(role) ?? 0) + 1);
        return this.ok({ did: player, role, soulbound: true }, `registry-grant-${player}`);
      }
      case "revoke_role": {
        if (!registry) this.fail("Unauthorized");
        const player = String(p.player_did ?? "");
        if (p.admin_did !== registry.admin) this.fail("Unauthorized");
        if (!this.verify(registry.admin, `revoke:${player}`, String(p.signature ?? ""))) this.fail("Unauthorized");
        const entry = registry.roles.get(player);
        if (!entry) this.fail("NotFound");
        entry.revoked = true;
        return this.ok({ did: player, revoked: true }, `registry-revoke-${player}`);
      }
      case "role_of": {
        const entry = registry?.roles.get(String(p.did ?? ""));
        if (!entry) this.fail("NoRoleToken");
        return this.ok({ did: p.did, role: entry.role, revoked: entry.revoked }, `registry-role-${p.did}`);
      }
      case "is_registered": {
        const entry = registry?.roles.get(String(p.did ?? ""));
        return this.ok({ registered: !!entry && !entry.revoked }, `registry-reg-${p.did}`);
      }
      case "has_role": {
        const entry = registry?.roles.get(String(p.did ?? ""));
        const role = String(p.role ?? "").toLowerCase();
        if (!entry || entry.revoked || entry.role !== role) this.fail("InsufficientRole");
        return this.ok({ has_role: true, role }, `registry-has-${p.did}`);
      }
      case "list_counts": {
        const counts = registry?.counts ?? new Map();
        return this.ok(
          {
            total: counts.get("total") ?? 0,
            player: counts.get("player") ?? 0,
            gamemaster: counts.get("gamemaster") ?? 0,
            auditor: counts.get("auditor") ?? 0,
          },
          "registry-counts"
        );
      }
      case "transfer":
        this.fail("soulbound: non-transferable");
      default:
        this.fail("unknown operation");
    }
  }

  /** Mirrors citizen-asset.v1: transferable tokens + timed multisig vaults. */
  private asset(operation: string, p: Record<string, unknown>): { output: Record<string, unknown>; meta: ChainWriteMeta } {
    const fail = (code: string): never => this.fail(code);
    const token = (id: string): AssetToken => {
      const t = this.assetTokens.get(id);
      if (!t) fail("TokenNotFound");
      return t!;
    };
    const balanceOf = (tokenId: string, did: string) => token(tokenId).balances.get(did) ?? 0;
    const credit = (tokenId: string, did: string, amount: number) => {
      const t = token(tokenId);
      t.balances.set(did, (t.balances.get(did) ?? 0) + amount);
      return t.balances.get(did)!;
    };
    const debit = (tokenId: string, did: string, amount: number) => {
      const t = token(tokenId);
      t.balances.set(did, (t.balances.get(did) ?? 0) - amount);
      return t.balances.get(did)!;
    };
    const countSigs = (allowed: string[], dids: string, sigs: string, message: string) => {
      const didList = dids.split(",");
      const sigList = sigs.split(",");
      const seen = new Set<string>();
      let valid = 0;
      for (let i = 0; i < Math.min(didList.length, sigList.length); i++) {
        const did = didList[i];
        if (!did || !sigList[i] || !allowed.includes(did) || seen.has(did)) continue;
        if (!this.verify(did, message, sigList[i])) continue;
        seen.add(did);
        valid += 1;
      }
      return valid;
    };

    switch (operation) {
      case "configure": {
        const admin = String(p.admin_did ?? "");
        const issuers = String(p.issuers ?? "");
        const threshold = Number(p.threshold ?? 1);
        if (!admin || !issuers) fail("missing required fields: admin_did, issuers");
        if (this.assetConfig) {
          const message = `configure:${issuers}:${threshold}`;
          if (!this.verify(this.assetConfig.admin, message, String(p.admin_sig ?? ""))) {
            fail("admin signature verification failed");
          }
        } else {
          this.ensureGovernanceApproved(String(p.proposal_id ?? ""), "asset");
        }
        this.assetConfig = { admin, issuers: issuers.split(",").filter(Boolean), threshold: Math.max(1, threshold) };
        return this.ok(
          { admin, issuers: this.assetConfig.issuers.length, threshold: this.assetConfig.threshold },
          "asset-configure"
        );
      }
      case "create_token": {
        const tokenId = String(p.token_id ?? "");
        const symbol = String(p.symbol ?? "");
        const decimals = Number(p.decimals ?? 0);
        if (!tokenId || !symbol) fail("missing required fields: token_id, symbol");
        if (!this.assetConfig) fail("asset module not configured");
        if (this.assetTokens.has(tokenId)) fail("TokenExists");
        const message = assetMessages.createToken(tokenId, symbol, decimals);
        if (countSigs(this.assetConfig!.issuers, String(p.issuer_dids ?? ""), String(p.signatures ?? ""), message) < this.assetConfig!.threshold) {
          fail("issuer threshold not met");
        }
        this.assetTokens.set(tokenId, { symbol, decimals, supply: 0, balances: new Map() });
        return this.ok({ token_id: tokenId, symbol, decimals }, `asset-create-${tokenId}`);
      }
      case "mint": {
        const tokenId = String(p.token_id ?? "");
        const recipient = String(p.recipient_did ?? "");
        const amount = Number(p.amount ?? 0);
        const ref = String(p.ref ?? "");
        if (!tokenId || !recipient || !ref) fail("missing required fields: token_id, recipient_did, ref");
        token(tokenId);
        if (amount <= 0) fail("InvalidAmount");
        const message = assetMessages.mint(tokenId, recipient, amount, ref);
        if (countSigs(this.assetConfig!.issuers, String(p.issuer_dids ?? ""), String(p.signatures ?? ""), message) < this.assetConfig!.threshold) {
          fail("issuer threshold not met");
        }
        token(tokenId).supply += amount;
        const balance = credit(tokenId, recipient, amount);
        return this.ok({ token_id: tokenId, recipient, amount, balance }, `asset-mint-${ref}`);
      }
      case "burn": {
        const tokenId = String(p.token_id ?? "");
        const owner = String(p.owner_did ?? "");
        const amount = Number(p.amount ?? 0);
        const ref = String(p.ref ?? "");
        token(tokenId);
        if (amount <= 0) fail("InvalidAmount");
        const message = assetMessages.burn(tokenId, owner, amount, ref);
        if (!this.verify(owner, message, String(p.signature ?? ""))) {
          fail("owner signature verification failed");
        }
        if (balanceOf(tokenId, owner) < amount) fail("InsufficientFunds");
        token(tokenId).supply -= amount;
        const balance = debit(tokenId, owner, amount);
        return this.ok({ burned: amount, balance }, `asset-burn-${ref}`);
      }
      case "transfer": {
        const tokenId = String(p.token_id ?? "");
        const from = String(p.from_did ?? "");
        const to = String(p.to_did ?? "");
        const amount = Number(p.amount ?? 0);
        const ref = String(p.ref ?? "");
        if (!tokenId || !from || !to || !ref) fail("missing required fields: token_id, from_did, to_did, ref");
        if (from === to) fail("cannot transfer to self");
        token(tokenId);
        if (amount <= 0) fail("InvalidAmount");
        const message = assetMessages.transfer(tokenId, from, to, amount, ref);
        if (!this.verify(from, message, String(p.signature ?? ""))) {
          fail("sender signature verification failed");
        }
        if (balanceOf(tokenId, from) < amount) fail("InsufficientFunds");
        debit(tokenId, from, amount);
        const recipientBalance = credit(tokenId, to, amount);
        return this.ok({ token_id: tokenId, from, to, amount, recipient_balance: recipientBalance }, `asset-transfer-${ref}`);
      }
      case "open_vault": {
        const vaultId = String(p.vault_id ?? "");
        const tokenId = String(p.token_id ?? "");
        const approvers = String(p.approver_dids ?? "").split(",").filter(Boolean);
        const threshold = Number(p.threshold ?? 0);
        const expiryBlock = Number(p.expiry_block ?? 0);
        const fallbackOwner = String(p.fallback_owner_did ?? "");
        if (!this.assetConfig) fail("asset module not configured");
        if (p.admin_did !== this.assetConfig!.admin) fail("NotAdmin");
        if (this.assetVaults.has(vaultId)) fail("VaultExists");
        token(tokenId);
        if (threshold < 1) fail("invalid threshold");
        if (expiryBlock <= 0) fail("invalid expiry_block");
        const message = assetMessages.openVault(vaultId, tokenId, threshold, expiryBlock);
        if (!this.verify(this.assetConfig!.admin, message, String(p.admin_sig ?? ""))) {
          fail("admin signature verification failed");
        }
        this.assetVaults.set(vaultId, { token: tokenId, approvers, threshold, expiryBlock, fallbackOwner });
        return this.ok(
          {
            vault_id: vaultId,
            account: assetMessages.vaultAccount(vaultId),
            token_id: tokenId,
            threshold,
            expiry_block: expiryBlock,
          },
          `asset-vopen-${vaultId}`
        );
      }
      case "vault_transfer": {
        const vaultId = String(p.vault_id ?? "");
        const to = String(p.to_did ?? "");
        const amount = Number(p.amount ?? 0);
        const ref = String(p.ref ?? "");
        const vault = this.assetVaults.get(vaultId);
        if (!vault) fail("VaultNotFound");
        if (p.token_id !== vault!.token) fail("TokenMismatch");
        if (amount <= 0) fail("InvalidAmount");
        const vaultAccount = assetMessages.vaultAccount(vaultId);
        if (balanceOf(vault!.token, vaultAccount) < amount) fail("InsufficientVaultFunds");
        const message = assetMessages.vaultTransfer(vaultId, to, amount, ref);
        const expired = this.blockHeight > vault!.expiryBlock;
        if (expired) {
          const didList = String(p.cosigner_dids ?? "").split(",");
          const sigList = String(p.signatures ?? "").split(",");
          const idx = didList.indexOf(vault!.fallbackOwner);
          const sig = idx >= 0 ? sigList[idx] : undefined;
          if (!sig || !this.verify(vault!.fallbackOwner, message, sig)) {
            fail("vault expired; fallback owner signature required");
          }
        } else if (
          countSigs(vault!.approvers, String(p.cosigner_dids ?? ""), String(p.signatures ?? ""), message) < vault!.threshold
        ) {
          fail("vault threshold not met");
        }
        debit(vault!.token, vaultAccount, amount);
        const recipientBalance = credit(vault!.token, to, amount);
        return this.ok(
          { vault_id: vaultId, to, amount, recipient_balance: recipientBalance, expired },
          `asset-vtransfer-${ref}`
        );
      }
      case "vault_info": {
        const vault = this.assetVaults.get(String(p.vault_id ?? ""));
        if (!vault) fail("VaultNotFound");
        const expired = this.blockHeight > vault!.expiryBlock;
        return this.ok(
          {
            vault_id: p.vault_id,
            token_id: vault!.token,
            account: assetMessages.vaultAccount(String(p.vault_id)),
            threshold: vault!.threshold,
            expiry_block: vault!.expiryBlock,
            fallback_owner: vault!.fallbackOwner,
            approvers: vault!.approvers.join(","),
            balance: balanceOf(vault!.token, assetMessages.vaultAccount(String(p.vault_id))),
            expired,
          },
          `asset-vinfo-${p.vault_id}`
        );
      }
      case "balance": {
        const tokenId = String(p.token_id ?? "");
        token(tokenId);
        return this.ok({ token_id: tokenId, did: p.did, balance: balanceOf(tokenId, String(p.did ?? "")) }, `asset-bal-${tokenId}-${p.did}`);
      }
      case "token_info": {
        const tokenId = String(p.token_id ?? "");
        const t = token(tokenId);
        return this.ok(
          { token_id: tokenId, symbol: t.symbol, decimals: t.decimals, total_supply: t.supply, transferable: true },
          `asset-tinfo-${tokenId}`
        );
      }
      default:
        return this.fail("unknown operation");
    }
  }
}
