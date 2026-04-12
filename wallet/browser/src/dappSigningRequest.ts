import { canonicalJson, sha256DigestHex } from './canonical';

export const DAPP_SIGNING_METHOD = 'ctzn_signCitizenTx';
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_PAYLOAD_CHARS = 64_000;

export type DappSigningRiskFlag =
  | 'unknown_origin'
  | 'stale_request'
  | 'large_payload'
  | 'unsupported_fields'
  | 'policy_violation';

export type DappSigningPolicyCheck = {
  code:
    | 'payload_not_object'
    | 'missing_namespace'
    | 'invalid_namespace'
    | 'missing_operation'
    | 'builder_credit_payload_missing'
    | 'form_commitment_receipt_missing';
  message: string;
};

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
  policyChecks: DappSigningPolicyCheck[];
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
  const protocolHintFields = new Set([
    'namespace',
    'action',
    'operation',
    'entry',
    'objectId',
    'object_id',
    'consent',
    'metadata',
    'proof',
    'builderCredit',
    'assetControl',
    'privacy',
    'timestamp',
    'nonce',
    'payload',
  ]);
  const keys = Object.keys(payload);
  const appearsToBeProtocolPayload = keys.some((key) => protocolHintFields.has(key));
  if (!appearsToBeProtocolPayload) {
    return false;
  }

  const allowed = new Set([
    'namespace',
    'action',
    'operation',
    'entry',
    'objectId',
    'object_id',
    'consent',
    'metadata',
    'proof',
    'builderCredit',
    'assetControl',
    'privacy',
    'timestamp',
    'nonce',
    'payload',
  ]);

  return keys.some((key) => !allowed.has(key));
}

function collectPolicyChecks(payload: unknown): DappSigningPolicyCheck[] {
  if (!isObjectRecord(payload)) {
    return [
      {
        code: 'payload_not_object',
        message: 'Payload must be a JSON object with namespace and operation fields.',
      },
    ];
  }

  const checks: DappSigningPolicyCheck[] = [];
  const namespace = payload.namespace;
  const operation = payload.operation ?? payload.action;
  const hasNamespace = namespace !== undefined && namespace !== null;
  const hasOperation = operation !== undefined && operation !== null;

  if (!hasNamespace && !hasOperation) {
    return checks;
  }

  if (typeof namespace !== 'string' || namespace.trim().length === 0) {
    checks.push({
      code: 'missing_namespace',
      message: 'Payload namespace is required before signing.',
    });
  } else if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)+$/u.test(namespace.trim())) {
    checks.push({
      code: 'invalid_namespace',
      message: 'Payload namespace must use lowercase dot-delimited segments.',
    });
  }

  if (typeof operation !== 'string' || operation.trim().length === 0) {
    checks.push({
      code: 'missing_operation',
      message: 'Payload action/operation is required before signing.',
    });
  }

  if (namespace === 'builder.credits' && !isObjectRecord(payload.builderCredit)) {
    checks.push({
      code: 'builder_credit_payload_missing',
      message: 'builder.credits payloads should include builderCredit policy details.',
    });
  }

  if (namespace === 'forms.commitment') {
    const formPayload = isObjectRecord(payload.payload) ? payload.payload : null;
    const dataHash = formPayload?.data_hash;
    const encryptedFormUrl = formPayload?.encrypted_form_url;
    if (
      typeof dataHash !== 'string'
      || !dataHash.startsWith('sha256:')
      || typeof encryptedFormUrl !== 'string'
      || encryptedFormUrl.trim().length === 0
    ) {
      checks.push({
        code: 'form_commitment_receipt_missing',
        message:
          'forms.commitment payload requires payload.data_hash (sha256:<hex>) and payload.encrypted_form_url.',
      });
    }
  }

  return checks;
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
  const parsedPayload =
    typeof input.payload === 'string'
      ? (() => {
          try {
            return JSON.parse(input.payload) as unknown;
          } catch {
            return input.payload;
          }
        })()
      : input.payload;
  const policyChecks = collectPolicyChecks(parsedPayload);
  if (!input.origin || !isValidHttpUrl(input.origin)) {
    riskFlags.push('unknown_origin');
  }
  if (canonicalPayload.length > MAX_PAYLOAD_CHARS) {
    riskFlags.push('large_payload');
  }
  if (collectUnsupportedTopLevelFields(parsedPayload)) {
    riskFlags.push('unsupported_fields');
  }
  if (policyChecks.length > 0) {
    riskFlags.push('policy_violation');
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
    policyChecks,
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

export function protocolSigningPreimageFromEnvelope(envelope: DappSigningRequestEnvelope): string {
  return envelope.canonicalPayload;
}
