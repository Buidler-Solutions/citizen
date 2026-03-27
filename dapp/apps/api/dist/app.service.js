"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppService = void 0;
const common_1 = require("@nestjs/common");
const node_crypto_1 = require("node:crypto");
const ethers_1 = require("ethers");
const db_service_1 = require("./db.service");
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_NETWORK = "futurenet";
const NODE_ENDPOINTS = {
    testnet: process.env.CITIZEN_TESTNET_SUBMIT_URL ?? "http://127.0.0.1:8081/api/v1/envelopes/submit",
    futurenet: process.env.CITIZEN_FUTURENET_SUBMIT_URL ?? "http://127.0.0.1:8082/api/v1/envelopes/submit",
    mainnet: process.env.CITIZEN_MAINNET_SUBMIT_URL ?? "http://127.0.0.1:8083/api/v1/envelopes/submit"
};
let AppService = class AppService {
    constructor(databaseService) {
        this.databaseService = databaseService;
        this.challenges = new Map();
        this.articles = [];
        this.sdkClients = new Map();
    }
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
                detail: "Article publishing signs a challenge, verifies signature server-side, and submits to selected network (testnet/futurenet/mainnet)."
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
                signature: "0x..."
            }
        };
    }
    getArticles() {
        return this.articles;
    }
    createArticleChallenge(authorWallet, draft, network, creditGrantId, sponsorBuilderId) {
        const normalizedAddress = this.validateWallet(authorWallet);
        const trimmedTitle = draft.title.trim();
        const trimmedContent = draft.content.trim();
        const selectedNetwork = this.resolveNetwork(network);
        const normalizedGrantId = typeof creditGrantId === "string" ? creditGrantId.trim() : "";
        const normalizedSponsorBuilderId = typeof sponsorBuilderId === "string" && sponsorBuilderId.trim().length > 0
            ? sponsorBuilderId.trim()
            : undefined;
        if (!normalizedGrantId) {
            throw new common_1.BadRequestException("creditGrantId is required for strict builder credit policy.");
        }
        if (trimmedTitle.length < 5 || trimmedContent.length < 20) {
            throw new common_1.BadRequestException("Article title/content too short for signing.");
        }
        const id = (0, node_crypto_1.randomUUID)();
        const createdAt = Date.now();
        const expiresAt = createdAt + CHALLENGE_TTL_MS;
        const contentHash = (0, node_crypto_1.createHash)("sha256").update(trimmedContent).digest("hex");
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
    async submitSignedArticle(challengeId, signature) {
        const challenge = this.challenges.get(challengeId);
        if (!challenge) {
            throw new common_1.BadRequestException("Unknown challenge. Request a fresh signing challenge.");
        }
        if (challenge.consumed) {
            throw new common_1.BadRequestException("Challenge already used.");
        }
        if (Date.now() > challenge.expiresAt) {
            throw new common_1.BadRequestException("Challenge expired. Request a new one.");
        }
        let recoveredAddress;
        try {
            recoveredAddress = (0, ethers_1.verifyMessage)(challenge.message, signature).toLowerCase();
        }
        catch {
            throw new common_1.BadRequestException("Invalid signature payload.");
        }
        if (recoveredAddress !== challenge.authorWallet) {
            throw new common_1.BadRequestException("Signature does not match challenge wallet.");
        }
        const nodeSubmission = await this.submitToNode(challenge, signature);
        challenge.consumed = true;
        const published = {
            id: (0, node_crypto_1.randomUUID)(),
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
    async submitToNode(challenge, signature) {
        const endpoint = NODE_ENDPOINTS[challenge.network];
        const isDemoEndpoint = endpoint.includes("/api/articles");
        const envelope = {
            envelope_id: (0, node_crypto_1.randomUUID)(),
            signer: challenge.authorWallet,
            signature,
            submitted_at: new Date().toISOString(),
            payload: {
                entry_id: (0, node_crypto_1.randomUUID)(),
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
                let parsedBody = bodyText;
                try {
                    parsedBody = JSON.parse(bodyText);
                }
                catch {
                }
                if (!response.ok) {
                    throw new common_1.ServiceUnavailableException({
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
        }
        catch (error) {
            if (error instanceof common_1.ServiceUnavailableException) {
                throw error;
            }
            throw new common_1.ServiceUnavailableException(`Unable to reach ${challenge.network} endpoint (${endpoint}).`);
        }
    }
    async getSdkClient(network) {
        const existingClient = this.sdkClients.get(network);
        if (existingClient) {
            return existingClient;
        }
        const { CitizenNodeClient } = (await Promise.resolve().then(() => require("@citizen-protocol/nodejs-sdk")));
        const baseUrl = this.resolveBaseUrl(NODE_ENDPOINTS[network]);
        const client = new CitizenNodeClient({ baseUrl });
        this.sdkClients.set(network, client);
        return client;
    }
    resolveBaseUrl(endpoint) {
        try {
            const parsed = new URL(endpoint);
            return `${parsed.protocol}//${parsed.host}`;
        }
        catch {
            throw new common_1.ServiceUnavailableException(`Configured endpoint is invalid: ${endpoint}`);
        }
    }
    validateWallet(address) {
        const normalized = address.trim().toLowerCase();
        if (!/^0x[a-f0-9]{40}$/.test(normalized)) {
            throw new common_1.BadRequestException("Wallet address must be a valid 20-byte hex address.");
        }
        return normalized;
    }
    resolveNetwork(network) {
        if (!network) {
            return DEFAULT_NETWORK;
        }
        if (network === "testnet" || network === "futurenet" || network === "mainnet") {
            return network;
        }
        throw new common_1.BadRequestException("network must be one of: testnet, futurenet, mainnet");
    }
};
exports.AppService = AppService;
exports.AppService = AppService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [db_service_1.DatabaseService])
], AppService);
