import { randomUUID } from "node:crypto";
import type { Store } from "../store.ts";
import { badRequest, notFound, unauthorized } from "../http.ts";

/**
 * Orgs module — team accounts for Game Masters, mirroring the original
 * TreasureNet organizations service. Orgs group GM DIDs so hunts and roles
 * can be managed per organization; the owner DID is the creating GM and the
 * only identity allowed to mutate membership.
 */

export interface OrgView {
  org_id: string;
  name: string;
  owner_did: string;
  members: Array<{ did: string; role: string }>;
  created_at: string;
}

export class OrgsModule {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  create(input: { owner_did?: string; name?: string }): OrgView {
    if (!input.owner_did || !input.owner_did.startsWith("did:key:ed25519:")) {
      badRequest("InvalidDid", "owner_did must be a did:key:ed25519 identity");
    }
    if (!input.name || input.name.trim().length < 2) {
      badRequest("InvalidName", "name of at least 2 characters is required");
    }
    const org = {
      org_id: `org-${randomUUID().slice(0, 8)}`,
      name: input.name!.trim(),
      owner_did: input.owner_did!,
      created_at: new Date().toISOString(),
      members: [{ did: input.owner_did!, role: "owner" }],
    };
    this.store.upsertOrg(org);
    this.store.recordEvent("org.created", "identity.orgs", { org_id: org.org_id, name: org.name });
    return this.view(org.org_id);
  }

  list(): OrgView[] {
    return [...this.store.orgs.values()].map((org) => this.toView(org));
  }

  get(orgId: string): OrgView {
    const org = this.store.orgs.get(orgId);
    if (!org) notFound("OrgNotFound", `org ${orgId} does not exist`);
    return this.toView(org!);
  }

  addMember(orgId: string, requesterDid: string, memberDid: string, role = "gamemaster"): OrgView {
    const org = this.store.orgs.get(orgId);
    if (!org) notFound("OrgNotFound", `org ${orgId} does not exist`);
    if (org!.owner_did !== requesterDid) {
      unauthorized("NotOrgOwner", "only the org owner can add members");
    }
    if (!memberDid.startsWith("did:key:ed25519:")) {
      badRequest("InvalidDid", "member did must be a did:key:ed25519 identity");
    }
    if (["owner"].includes(role)) {
      badRequest("InvalidRole", "owner membership cannot be granted");
    }
    this.store.upsertOrgMember(orgId, memberDid, role);
    this.store.recordEvent("org.member.added", "identity.orgs", { org_id: orgId, did: memberDid, role });
    return this.get(orgId);
  }

  removeMember(orgId: string, requesterDid: string, memberDid: string): OrgView {
    const org = this.store.orgs.get(orgId);
    if (!org) notFound("OrgNotFound", `org ${orgId} does not exist`);
    if (org!.owner_did !== requesterDid) {
      unauthorized("NotOrgOwner", "only the org owner can remove members");
    }
    if (memberDid === org!.owner_did) {
      badRequest("OwnerImmutable", "the org owner cannot be removed");
    }
    const member = org!.members.find((entry) => entry.did === memberDid);
    if (!member) {
      notFound("MemberNotFound", `${memberDid} is not a member of ${orgId}`);
    }
    this.store.removeOrgMember(orgId, memberDid);
    this.store.recordEvent("org.member.removed", "identity.orgs", { org_id: orgId, did: memberDid });
    return this.get(orgId);
  }

  private toView(org: { org_id: string; name: string; owner_did: string; created_at: string; members: Array<{ did: string; role: string }> }): OrgView {
    return {
      org_id: org.org_id,
      name: org.name,
      owner_did: org.owner_did,
      members: [...org.members],
      created_at: org.created_at,
    };
  }

  private view(orgId: string): OrgView {
    return this.get(orgId);
  }
}
