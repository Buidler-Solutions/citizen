import { randomUUID } from "node:crypto";
import type { ConsentReceipt } from "../../../../packages/shared/src/index.ts";
import type { Store } from "../store.ts";
import { badRequest } from "../http.ts";

/**
 * Consent module — Citizen consent receipts gate the oracle's processing of
 * player location and photo data. A receipt (90-day expiry) must exist and
 * be valid before any geo check-in or photo verdict is processed.
 */

const CONSENT_TTL_DAYS = 90;

export class ConsentModule {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  grant(subjectDid: string, purposes: ("location" | "photo")[]): ConsentReceipt {
    const valid = purposes.filter((p) => p === "location" || p === "photo");
    if (valid.length === 0) {
      badRequest("InvalidPurposes", "purposes must include location and/or photo");
    }
    const grantedAt = new Date();
    const expiresAt = new Date(grantedAt.getTime() + CONSENT_TTL_DAYS * 86_400_000);
    const receipt: ConsentReceipt = {
      subject_did: subjectDid,
      purposes: valid,
      granted_at: grantedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      receipt_id: randomUUID(),
    };
    this.store.consentReceipts.set(subjectDid, receipt);
    return receipt;
  }

  requireValid(subjectDid: string, purpose: "location" | "photo"): ConsentReceipt {
    const receipt = this.store.consentReceipts.get(subjectDid);
    if (!receipt) {
      badRequest("ConsentRequired", `no consent receipt for ${subjectDid}; grant one first`);
    }
    if (!receipt!.purposes.includes(purpose)) {
      badRequest("ConsentScope", `consent receipt does not cover ${purpose} processing`);
    }
    if (new Date(receipt!.expires_at).getTime() < Date.now()) {
      badRequest("ConsentExpired", "consent receipt expired; re-grant required");
    }
    return receipt!;
  }

  status(subjectDid: string) {
    return this.store.consentReceipts.get(subjectDid) ?? null;
  }
}
