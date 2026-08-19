import { verifyMessage, didFromPublicKey } from "./keys.ts";
import type { ChainAdapter, ChainWriteMeta } from "./modules.ts";
import { MODULES } from "./modules.ts";

/**
 * In-memory mock of the Citizen chain for offline development, CI, and
 * smoke tests. Mirrors the exact state machines and error codes of the
 * treasure-escrow / treasure-hunt / player-registry WASM modules plus
 * finality receipts and CTZN reward balances.
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
  receiptBlock: number;
}

interface RegistryState {
  admin: string;
  roles: Map<string, { role: string; revoked: boolean }>;
  counts: Map<string, number>;
}

export class MockChain implements ChainAdapter {
  private blockHeight = 100;
  private readonly escrows = new Map<string, EscrowState>();
  private readonly hunts = new Map<string, HuntState>();
  private readonly registries = new Map<string, RegistryState>();
  private readonly payouts = new Map<string, string>();
  private readonly balances = new Map<string, number>();
  private readonly receipts = new Map<string, Record<string, unknown>>();
  private readonly writeScopes = new Set<string>();

  setBlockHeight(height: number) {
    this.blockHeight = height;
  }

  currentBlock(): number {
    return this.blockHeight;
  }

  getCtznBalance(did: string): number {
    return this.balances.get(did) ?? 0;
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
    const scope = `${moduleId}:${operation}:${params.escrow_id ?? params.hunt_id ?? params.player_did ?? params.did ?? ""}`;
    const isWrite = !operation.startsWith("get") && !["is_expired", "is_registered", "has_role", "role_of", "list_counts"].includes(operation);
    if (isWrite && this.writeScopes.has(scope)) {
      this.fail("ReplayedSubmission");
    }
    if (isWrite) {
      this.writeScopes.add(scope);
    }

    if (moduleId === MODULES.escrow) return this.escrow(operation, params);
    if (moduleId === MODULES.hunt) return this.hunt(operation, params);
    if (moduleId === MODULES.registry) return this.registry(operation, params);
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
        const amount = Number(p.amount ?? 0);
        const deadline = Number(p.deadline_block ?? 0);
        if (amount <= 0) this.fail("InvalidAmount");
        if (deadline <= 0) this.fail("InvalidDeadline");
        if (state) this.fail("AlreadyInitialized");
        this.escrows.set(id, {
          owner: String(p.owner_did ?? ""),
          claimer: String(p.claimer_did ?? ""),
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
          if (oracles.includes(dids[i])) oracleSigned = true;
        }
        if (!ownerSigned) this.fail("NotOwner");
        if (!oracleSigned) this.fail("OracleSignatureRequired");
        state.status = "completed";
        state.winner = winner;
        state.receiptBlock = this.blockHeight;
        this.payouts.set(id, `${winner}:${state.amount}:${this.blockHeight}`);
        this.balances.set(winner, (this.balances.get(winner) ?? 0) + state.amount);
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
}
