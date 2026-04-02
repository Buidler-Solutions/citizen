import { canonicalJson, sha256DigestHex } from './canonical';

export const DAPP_SIGNING_METHOD = 'ctzn_signCitizenTx';
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_PAYLOAD_CHARS = 64_000;

export type DappSigningRiskFlag =
  | 'unknown_origin'
  | 'stale_request'
  | 'large_payload'
  | 'unsupported_fields';

export type DappSigningRequestEnvelope = {
  requestId: string;
  origin: string;
  tabUrl: string | null;
  method: typeof DAPP_SIGNING_METHOD;
  payload: unknown;
  canonicalPayload: string;
  payloadHash: string;
  createdAt: string;
  expiresAt: string;
  riskFlags: DappSigningRiskFlag[];
};

type DappSigningEnvelopeInput = {
  origin?: string;
  tabUrl?: string | null;
  payload: unknown;
  now?: Date;
  ttlMs?: number;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function collectUnsupportedTopLevelFields(payload: unknown): boolean {
  if (!isObjectRecord(payload)) {
    return false;
  }
  const allowed = new Set([
    'namespace',
    'operation',
    'entry',
    'consent',
    'metadata',
    'proof',
    'builderCredit',
    'assetControl',
    'privacy',
    'timestamp',
    'nonce',
  ]);

  return Object.keys(payload).some((key) => !allowed.has(key));
}

export async function createDappSigningRequestEnvelope(
  input: DappSigningEnvelopeInput,
): Promise<DappSigningRequestEnvelope> {
  const now = input.now ?? new Date();
  const ttlMs = Number.isFinite(input.ttlMs) ? Math.max(0, Math.floor(input.ttlMs ?? DEFAULT_TTL_MS)) : DEFAULT_TTL_MS;
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const canonicalPayload = typeof input.payload === 'string' ? input.payload : canonicalJson(input.payload);
  const payloadHash = await sha256DigestHex(canonicalPayload);

  const riskFlags: DappSigningRiskFlag[] = [];
  if (!input.origin || !isValidHttpUrl(input.origin)) {
    riskFlags.push('unknown_origin');
  }
  if (canonicalPayload.length > MAX_PAYLOAD_CHARS) {
    riskFlags.push('large_payload');
  }
  if (collectUnsupportedTopLevelFields(input.payload)) {
    riskFlags.push('unsupported_fields');
  }
  if (new Date(expiresAt).getTime() <= now.getTime()) {
    riskFlags.push('stale_request');
  }

  return {
    requestId: crypto.randomUUID(),
    origin: input.origin ?? 'unknown',
    tabUrl: input.tabUrl ?? null,
    method: DAPP_SIGNING_METHOD,
    payload: input.payload,
    canonicalPayload,
    payloadHash,
    createdAt,
    expiresAt,
    riskFlags,
  };
}

type SigningScopePayloadV2 = {
  scope: 'citizen_dapp_signing_v2';
  requestId: string;
  origin: string;
  tabUrl: string | null;
  method: typeof DAPP_SIGNING_METHOD;
  payloadHash: string;
  createdAt: string;
  expiresAt: string;
};

export function signingScopePayloadV2FromEnvelope(
  envelope: DappSigningRequestEnvelope,
): SigningScopePayloadV2 {
  return {
    scope: 'citizen_dapp_signing_v2',
    requestId: envelope.requestId,
    origin: envelope.origin,
    tabUrl: envelope.tabUrl,
    method: envelope.method,
    payloadHash: envelope.payloadHash,
    createdAt: envelope.createdAt,
    expiresAt: envelope.expiresAt,
  };
}

export function signingPreimageFromEnvelope(envelope: DappSigningRequestEnvelope): string {
  return canonicalJson(signingScopePayloadV2FromEnvelope(envelope));
}
