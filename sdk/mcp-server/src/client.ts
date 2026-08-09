export interface CitizenNodeConfig {
  baseUrl: string;
  apiKey?: string;
}

export class CitizenClient {
  private baseUrl: string;
  private apiKey?: string;

  constructor(config: CitizenNodeConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
  }

  private async request<T>(
    path: string,
    options: { method?: string; body?: unknown; params?: Record<string, string | number> } = {},
  ): Promise<T> {
    const { method = "GET", body, params } = options;

    let url = `${this.baseUrl}${path}`;
    if (params) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        search.set(key, String(value));
      }
      url += `?${search.toString()}`;
    }

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (!response.ok) {
      throw new Error(
        `Citizen API ${method} ${path} failed: ${response.status} ${response.statusText}${typeof data === "string" ? ` — ${data}` : ""}`,
      );
    }

    return data as T;
  }

  async getHealth(): Promise<{ status: string }> {
    return this.request("/health");
  }

  async listBlocks(limit?: number, cursor?: string) {
    return this.request("/blocks", { params: { ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}) } });
  }

  async getBlock(height: number) {
    return this.request(`/blocks/${height}`);
  }

  async listNamespaces() {
    return this.request("/namespaces");
  }

  async listEntries(namespace: string, limit?: number, cursor?: string) {
    return this.request(`/entries/${namespace}`, {
      params: { ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}) },
    });
  }

  async submitEntry(entry: unknown) {
    return this.request("/api/v1/entries/submit", { method: "POST", body: entry });
  }

  async submitEnvelope(envelope: unknown) {
    return this.request("/api/v1/envelopes/submit", { method: "POST", body: envelope });
  }

  async submitEnvelopeBatch(envelopes: unknown[]) {
    return this.request("/api/v1/envelopes/submit-batch", { method: "POST", body: envelopes });
  }

  async getReceipt(receiptId: string) {
    return this.request(`/api/v1/receipts/${receiptId}`);
  }

  async resolveDid(did: string) {
    return this.request(`/api/v1/identity/${encodeURIComponent(did)}`);
  }

  async getKycStatus(did: string) {
    return this.request(`/api/v1/identity/kyc/${encodeURIComponent(did)}`);
  }

  async listKyc() {
    return this.request("/api/v1/identity/kyc");
  }

  async checkConsent(consentReceipt: unknown) {
    return this.request("/api/v1/consent/check", { method: "POST", body: consentReceipt });
  }

  async getBuilderCredits(builderId: string) {
    return this.request(`/api/v1/builder-credits/${encodeURIComponent(builderId)}`);
  }

  async getAssetPositions(accountId: string) {
    return this.request(`/api/v1/assets/${encodeURIComponent(accountId)}`);
  }

  async getModuleRuntime(moduleId: string) {
    return this.request(`/api/v1/modules/${encodeURIComponent(moduleId)}`);
  }

  async executeModule(moduleId: string, payload: unknown) {
    return this.request(`/api/v1/modules/${encodeURIComponent(moduleId)}/execute`, {
      method: "POST",
      body: payload,
    });
  }

  async getInteropStatus(objectId: string) {
    return this.request(`/api/v1/interop/${encodeURIComponent(objectId)}`);
  }

  async getGovernanceProposals() {
    return this.request("/api/v1/governance/proposals");
  }

  async listCivicProposals() {
    return this.request("/api/v1/civic/proposals");
  }

  async getCivicProposal(proposalId: string) {
    return this.request(`/api/v1/civic/proposals/${encodeURIComponent(proposalId)}`);
  }

  async getCivicProposalTally(proposalId: string) {
    return this.request(`/api/v1/civic/proposals/${encodeURIComponent(proposalId)}/tally`);
  }

  async listCivicElections() {
    return this.request("/api/v1/civic/elections");
  }

  async getCivicElection(electionId: string) {
    return this.request(`/api/v1/civic/elections/${encodeURIComponent(electionId)}`);
  }

  async getCivicElectionTally(electionId: string) {
    return this.request(`/api/v1/civic/elections/${encodeURIComponent(electionId)}/tally`);
  }

  async getCivicElectionBallots(electionId: string) {
    return this.request(`/api/v1/civic/elections/${encodeURIComponent(electionId)}/ballots`);
  }

  async checkCivicAdmin(did: string) {
    return this.request(`/api/v1/civic/admin/check/${encodeURIComponent(did)}`);
  }

  async getCivicKycPublicKey() {
    return this.request("/api/v1/civic/admin/kyc-public-key");
  }

  async checkCivicRegistry(did: string) {
    return this.request(`/api/v1/civic/registry/${encodeURIComponent(did)}`);
  }

  async checkVoterEligibility(electionId: string, did: string) {
    return this.request(`/api/v1/civic/elections/${encodeURIComponent(electionId)}/eligibility/${encodeURIComponent(did)}`);
  }

  async getCtznStatus(moduleId: string) {
    return this.request(`/api/v1/ctzn/${encodeURIComponent(moduleId)}/status`);
  }

  async getCtznHolders(moduleId: string) {
    return this.request(`/api/v1/ctzn/${encodeURIComponent(moduleId)}/holders`);
  }

  async getCtznBalance(moduleId: string, did: string) {
    return this.request(`/api/v1/ctzn/${encodeURIComponent(moduleId)}/check/${encodeURIComponent(did)}`);
  }

  async createFileIntent(intent: unknown) {
    return this.request("/api/v1/files/intents", { method: "POST", body: intent });
  }

  async commitFile(commit: unknown) {
    return this.request("/api/v1/files/commit", { method: "POST", body: commit });
  }

  async readFile(readRequest: unknown) {
    return this.request("/api/v1/files/read", { method: "POST", body: readRequest });
  }

  async revokeFileReader(revokeRequest: unknown) {
    return this.request("/api/v1/files/revoke", { method: "POST", body: revokeRequest });
  }

  async getFileManifest(manifestId: string) {
    return this.request(`/api/v1/files/manifests/${encodeURIComponent(manifestId)}`);
  }

  async listFileAlerts() {
    return this.request("/api/v1/files/alerts");
  }

  async commitPayload(commit: unknown) {
    return this.request("/api/v1/payloads/commit", { method: "POST", body: commit });
  }

  async getPayloadFieldRefs(entryId: string, namespace: string) {
    return this.request(`/api/v1/payloads/fields/${encodeURIComponent(entryId)}/${encodeURIComponent(namespace)}`);
  }

  async getPayloadByDataHash(dataHash: string) {
    return this.request(`/api/v1/payloads/data-hash/${encodeURIComponent(dataHash)}`);
  }
}
