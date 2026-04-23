import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException
} from "@nestjs/common";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { verifyMessage } from "ethers";
import { DatabaseService } from "./db.service";

type CitizenNodeClientInstance = {
  submitEnvelope: (envelope: unknown) => Promise<unknown>;
};

type ArticleDraft = {
  title: string;
  content: string;
};

type TargetNetwork = "testnet" | "futurenet" | "mainnet";

type ArticleChallenge = {
  id: string;
  authorWallet: string;
  network: TargetNetwork;
  draft: ArticleDraft;
  creditGrantId: string;
  sponsorBuilderId?: string;
  message: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
};

type NodeSubmission = {
  endpoint: string;
  network: TargetNetwork;
  status: number;
  response: unknown;
  submittedAt: string;
};

type PublishedArticle = {
  id: string;
  title: string;
  content: string;
  authorWallet: string;
  signature: string;
  signedMessage: string;
  network: TargetNetwork;
  submittedAt: string;
  nodeSubmission: NodeSubmission;
};

type WalletAuthChallenge = {
  id: string;
  wallet: string;
  network: TargetNetwork;
  domain: string;
  uri: string;
  nonce: string;
  message: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
};

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const AUTH_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_NETWORK: TargetNetwork = "futurenet";

const NODE_ENDPOINTS: Record<TargetNetwork, string> = {
  testnet:
    process.env.CITIZEN_TESTNET_SUBMIT_URL ?? "http://127.0.0.1:8081/api/v1/envelopes/submit",
  futurenet:
    process.env.CITIZEN_FUTURENET_SUBMIT_URL ?? "http://127.0.0.1:8082/api/v1/envelopes/submit",
  mainnet:
    process.env.CITIZEN_MAINNET_SUBMIT_URL ?? "http://127.0.0.1:8083/api/v1/envelopes/submit"
};

@Injectable()
export class AppService {
  private readonly challenges = new Map<string, ArticleChallenge>();
  private readonly authChallenges = new Map<string, WalletAuthChallenge>();
  private readonly articles: PublishedArticle[] = [];
  private readonly sdkClients = new Map<TargetNetwork, CitizenNodeClientInstance>();

  constructor(private readonly databaseService: DatabaseService) {}

  async getHealth() {
    const database = await this.databaseService.checkConnection();
    return {
      status: "ok",
      service: "citizen-dapp-api",
      database,
      articlePublishing: {
        challengeTtlSeconds: CHALLENGE_TTL_MS / 1000,
        publishedCount: this.articles.length,
        defaultNetwork: DEFAULT_NETWORK,
        networkEndpoints: NODE_ENDPOINTS
      },
      walletAuth: {
        challengeTtlSeconds: AUTH_CHALLENGE_TTL_MS / 1000
      }
    };
  }

  getNetworks() {
    return {
      defaultNetwork: DEFAULT_NETWORK,
      networks: NODE_ENDPOINTS
    };
  }

  getCapabilities() {
    return {
      consensus: {
        name: "Deterministic Finality",
        detail: "Linear BFT consensus requiring ≥80% quorum with immediate finalization."
      },
      governance: {
        name: "Governance Engine",
        detail: "Validator-driven proposals and votes control protocol upgrades and validator sets."
      },
      validators: {
        name: "Validator Lifecycle",
        detail: "Identity-anchored admission, suspension, and removal with on-chain auditability."
      },
      namespaces: {
        name: "Namespace Rule Engine",
        detail: "Domain-specific rules enforce who can write and what proof is required."
      },
      ledger: {
        name: "Ledger Entries",
        detail: "Append-only event records secured with signatures and merkle roots."
      },
      security: {
        name: "Security Guarantees",
        detail: "Sybil resistance, deterministic finality, and governance-first safety controls."
      },
      publishing: {
        name: "Wallet Sign and Submit",
        detail:
          "Article publishing signs a challenge, verifies signature server-side, and submits to selected network (testnet/futurenet/mainnet)."
      },
      walletAuth: {
        name: "Wallet Login (Backend Verified)",
        detail:
          "Citizen wallet login pattern with backend nonce challenge, signature verification, and session issuance for Citizen dApps."
      }
    };
  }

  getNamespaces() {
    return [
      {
        namespace: "identity.citizen",
        actions: ["REGISTER_IDENTITY", "UPDATE_CLAIM", "REVOKE_IDENTITY"]
      },
      {
        namespace: "registry.land",
        actions: ["REGISTER_PARCEL", "TRANSFER_OWNERSHIP", "ANNOTATE_DISPUTE"]
      },
      {
        namespace: "audit.procurement",
        actions: ["RECORD_EVENT", "LINK_DOCUMENT", "CLOSE_AUDIT"]
      },
      {
        namespace: "governance.vote",
        actions: ["SUBMIT_PROPOSAL", "CAST_VOTE", "EXECUTE_PROPOSAL"]
      },
      {
        namespace: "builder.credits",
        actions: ["MULTISIG_CREDIT_GRANT", "PROGRAMMABLE_CREDIT_GRANT", "SPONSOR_USAGE"]
      },
      {
        namespace: "content.article",
        actions: ["PUBLISH_ARTICLE"]
      }
    ];
  }

  getWorkflows() {
    return {
      identity: {
        entry_id: "uuid-identity-001",
        namespace: "identity.citizen",
        action: "REGISTER_IDENTITY",
        subject: "did:ledger:citizen:alexa",
        claims_hash: "bafybeigdyr...",
        signature: "sig:citizen-alexa",
        timestamp: 1736500000
      },
      article: {
        namespace: "content.article",
        action: "PUBLISH_ARTICLE",
        signer: "0x1234...abcd",
        network: "futurenet",
        challenge: "Sign challenge message generated by /articles/challenge",
        submit_to_node: NODE_ENDPOINTS.futurenet,
        signature: "0x...",
        payload: {
          credit_grant_id: "grant:builder:alpha",
          sponsor_builder_id: "did:ledger:builder:alpha"
        }
      },
      sponsorship: {
        namespace: "builder.credits",
        action: "SPONSOR_USAGE",
        object_id: "sponsorship:demo:001",
        author: "did:ledger:builder:alpha",
        payload: {
          credit_grant_id: "grant:builder:alpha",
          sponsor_builder_id: "did:ledger:builder:alpha",
          sponsorship_id: "sponsorship:demo:001",
          sponsored_did: "did:ledger:app:demo",
          units: 1,
          purpose: "content.article publish"
        }
      }
    };
  }

  getArticles() {
    return this.articles;
  }

  createWalletAuthChallenge(wallet: string, domain?: string, uri?: string, network?: string) {
    const normalizedWallet = this.validateWallet(wallet);
    const selectedNetwork = this.resolveNetwork(network);
    const normalizedDomain =
      typeof domain === "string" && domain.trim().length > 0 ? domain.trim() : "unknown-domain";
    const normalizedUri =
      typeof uri === "string" && uri.trim().length > 0 ? uri.trim() : "unknown-uri";
    const id = randomUUID();
    const nonce = randomBytes(16).toString("hex");
    const createdAt = Date.now();
    const expiresAt = createdAt + AUTH_CHALLENGE_TTL_MS;

    const message = [
      "Citizen Protocol Wallet Login",
      `Challenge: ${id}`,
      `Wallet: ${normalizedWallet}`,
      `Network: ${selectedNetwork}`,
      `Domain: ${normalizedDomain}`,
      `URI: ${normalizedUri}`,
      `Nonce: ${nonce}`,
      `Issued At: ${new Date(createdAt).toISOString()}`,
      `Expires At: ${new Date(expiresAt).toISOString()}`
    ].join("\n");

    this.authChallenges.set(id, {
      id,
      wallet: normalizedWallet,
      network: selectedNetwork,
      domain: normalizedDomain,
      uri: normalizedUri,
      nonce,
      message,
      createdAt,
      expiresAt,
      consumed: false
    });

    return {
      challengeId: id,
      wallet: normalizedWallet,
      network: selectedNetwork,
      nonce,
      message,
      issuedAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString()
    };
  }

  verifyWalletAuthChallenge(challengeId: string, wallet: string, signature: string) {
    const challenge = this.authChallenges.get(challengeId);
    if (!challenge) {
      throw new BadRequestException("Unknown auth challenge.");
    }

    if (challenge.consumed) {
      throw new BadRequestException("Auth challenge already consumed.");
    }

    if (Date.now() > challenge.expiresAt) {
      throw new BadRequestException("Auth challenge expired.");
    }

    const normalizedWallet = this.validateWallet(wallet);
    if (normalizedWallet !== challenge.wallet) {
      throw new BadRequestException("Challenge wallet mismatch.");
    }

    let recoveredAddress: string;
    try {
      recoveredAddress = verifyMessage(challenge.message, signature).toLowerCase();
    } catch {
      throw new BadRequestException("Invalid auth signature payload.");
    }

    if (recoveredAddress !== challenge.wallet) {
      throw new BadRequestException("Auth signature does not match challenge wallet.");
    }

    challenge.consumed = true;
    const sessionId = randomUUID();
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + AUTH_CHALLENGE_TTL_MS).toISOString();

    return {
      status: "authenticated",
      session: {
        sessionId,
        wallet: challenge.wallet,
        network: challenge.network,
        issuedAt,
        expiresAt
      },
      proof: {
        challengeId: challenge.id,
        nonce: challenge.nonce,
        message: challenge.message,
        signature
      }
    };
  }

  createArticleChallenge(
    authorWallet: string,
    draft: ArticleDraft,
    network?: string,
    creditGrantId?: string,
    sponsorBuilderId?: string
  ) {
    const normalizedAddress = this.validateWallet(authorWallet);
    const trimmedTitle = draft.title.trim();
    const trimmedContent = draft.content.trim();
    const selectedNetwork = this.resolveNetwork(network);
    const normalizedGrantId = typeof creditGrantId === "string" ? creditGrantId.trim() : "";
    const normalizedSponsorBuilderId =
      typeof sponsorBuilderId === "string" && sponsorBuilderId.trim().length > 0
        ? sponsorBuilderId.trim()
        : undefined;

    if (!normalizedGrantId) {
      throw new BadRequestException("creditGrantId is required for strict builder credit policy.");
    }

    if (trimmedTitle.length < 5 || trimmedContent.length < 20) {
      throw new BadRequestException("Article title/content too short for signing.");
    }

    const id = randomUUID();
    const createdAt = Date.now();
    const expiresAt = createdAt + CHALLENGE_TTL_MS;
    const contentHash = createHash("sha256").update(trimmedContent).digest("hex");
    const message = [
      "Citizen DApp Article Publish",
      `Challenge: ${id}`,
      `Wallet: ${normalizedAddress}`,
      `Network: ${selectedNetwork}`,
      `Title: ${trimmedTitle}`,
      `Content Hash: ${contentHash}`,
      `Issued At: ${new Date(createdAt).toISOString()}`,
      `Expires At: ${new Date(expiresAt).toISOString()}`
    ].join("\n");

    this.challenges.set(id, {
      id,
      authorWallet: normalizedAddress,
      network: selectedNetwork,
      draft: {
        title: trimmedTitle,
        content: trimmedContent
      },
      creditGrantId: normalizedGrantId,
      sponsorBuilderId: normalizedSponsorBuilderId,
      message,
      createdAt,
      expiresAt,
      consumed: false
    });

    return {
      challengeId: id,
      network: selectedNetwork,
      message,
      expiresAt: new Date(expiresAt).toISOString()
    };
  }

  async submitSignedArticle(challengeId: string, signature: string) {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) {
      throw new BadRequestException("Unknown challenge. Request a fresh signing challenge.");
    }

    if (challenge.consumed) {
      throw new BadRequestException("Challenge already used.");
    }

    if (Date.now() > challenge.expiresAt) {
      throw new BadRequestException("Challenge expired. Request a new one.");
    }

    let recoveredAddress: string;
    try {
      recoveredAddress = verifyMessage(challenge.message, signature).toLowerCase();
    } catch {
      throw new BadRequestException("Invalid signature payload.");
    }

    if (recoveredAddress !== challenge.authorWallet) {
      throw new BadRequestException("Signature does not match challenge wallet.");
    }

    const nodeSubmission = await this.submitToNode(challenge, signature);

    challenge.consumed = true;
    const published: PublishedArticle = {
      id: randomUUID(),
      title: challenge.draft.title,
      content: challenge.draft.content,
      authorWallet: challenge.authorWallet,
      signature,
      signedMessage: challenge.message,
      network: challenge.network,
      submittedAt: new Date().toISOString(),
      nodeSubmission
    };

    this.articles.unshift(published);

    return {
      status: "accepted",
      article: published
    };
  }

  private async submitToNode(challenge: ArticleChallenge, signature: string) {
    const endpoint = NODE_ENDPOINTS[challenge.network];
    const isDemoEndpoint = endpoint.includes("/api/articles");
    const envelope = {
      envelope_id: randomUUID(),
      signer: challenge.authorWallet,
      signature,
      submitted_at: new Date().toISOString(),
      payload: {
        entry_id: randomUUID(),
        namespace: "content.article",
        action: "PUBLISH_ARTICLE",
        object_id: `article:${challenge.id}`,
        payload: {
          title: challenge.draft.title,
          content: challenge.draft.content,
          signedMessage: challenge.message,
          network: challenge.network,
          credit_grant_id: challenge.creditGrantId,
          sponsor_builder_id: challenge.sponsorBuilderId ?? challenge.authorWallet
        },
        author: challenge.authorWallet,
        signature,
        timestamp: Math.floor(Date.now() / 1000)
      }
    };

    try {
      if (isDemoEndpoint) {
        const payload = {
          author: challenge.authorWallet,
          title: challenge.draft.title,
          content: challenge.draft.content,
          tags: ["citizen-dapp", challenge.network],
          signedMessage: challenge.message,
          walletSignature: signature,
          creditGrantId: challenge.creditGrantId,
          sponsorBuilderId: challenge.sponsorBuilderId ?? challenge.authorWallet
        };

        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(payload)
        });

        const bodyText = await response.text();
        let parsedBody: unknown = bodyText;
        try {
          parsedBody = JSON.parse(bodyText);
        } catch {
          // keep raw text as fallback
        }

        if (!response.ok) {
          throw new ServiceUnavailableException({
            message: `Network ${challenge.network} rejected article submission.`,
            endpoint,
            status: response.status,
            response: parsedBody
          });
        }

        return {
          endpoint,
          network: challenge.network,
          status: response.status,
          response: parsedBody,
          submittedAt: new Date().toISOString()
        };
      }

      const client = await this.getSdkClient(challenge.network);
      const parsedBody = await client.submitEnvelope(envelope);
      return {
        endpoint,
        network: challenge.network,
        status: 200,
        response: parsedBody,
        submittedAt: new Date().toISOString()
      };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }

      throw new ServiceUnavailableException(
        `Unable to reach ${challenge.network} endpoint (${endpoint}).`
      );
    }
  }

  private async getSdkClient(network: TargetNetwork): Promise<CitizenNodeClientInstance> {
    const existingClient = this.sdkClients.get(network);
    if (existingClient) {
      return existingClient;
    }

    const { CitizenNodeClient } = (await import("@citizen-protocol/typescript-sdk")) as {
      CitizenNodeClient: new (args: { baseUrl: string }) => CitizenNodeClientInstance;
    };

    const baseUrl = this.resolveBaseUrl(NODE_ENDPOINTS[network]);
    const client = new CitizenNodeClient({ baseUrl });
    this.sdkClients.set(network, client);
    return client;
  }

  private resolveBaseUrl(endpoint: string) {
    try {
      const parsed = new URL(endpoint);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      throw new ServiceUnavailableException(`Configured endpoint is invalid: ${endpoint}`);
    }
  }

  private validateWallet(address: string) {
    const normalized = address.trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(normalized)) {
      throw new BadRequestException("Wallet address must be a valid 20-byte hex address.");
    }
    return normalized;
  }

  private resolveNetwork(network?: string): TargetNetwork {
    if (!network) {
      return DEFAULT_NETWORK;
    }
    if (network === "testnet" || network === "futurenet" || network === "mainnet") {
      return network;
    }
    throw new BadRequestException("network must be one of: testnet, futurenet, mainnet");
  }
}
