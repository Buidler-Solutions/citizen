export type LedgerEntry = {
  entry_id: string;
  namespace: string;
  action: string;
  object_id: string;
  payload: Record<string, unknown>;
  author: string;
  timestamp: number;
  signature: string;
};

export type SignedEnvelope = {
  envelope_id: string;
  signer: string;
  signature: string;
  submitted_at: string;
  payload: LedgerEntry;
};

export type SignedSubmissionArtifact = {
  signerDid: string;
  verifyingKey: string;
  signature: string;
  payloadHash: string;
  signingPayload: string;
  signatureScope: string;
  algorithm: string;
  requestId?: string;
};

export type DirectSubmitRequest = {
  destinationUrl: string;
  allowlistedDestinations: readonly string[];
  signedArtifact: SignedSubmissionArtifact;
  consentToShareSigningPayload?: boolean;
  fetchImpl?: typeof fetch;
};

export type CitizenNetworkSubmitRequest = {
  apiBaseUrl: string;
  allowlistedApiBaseUrls: readonly string[];
  envelope: SignedEnvelope;
  consentToShareFullPayload: boolean;
  apiKey?: string;
  fetchImpl?: typeof fetch;
};

export type DirectSubmitResponse = {
  traceId: string;
  status: number;
  latencyMs: number;
  receiptId: string | null;
  receiptHash: string | null;
};

export type ReceiptLookupRequest = {
  receiptUrl: string;
  allowlistedDestinations: readonly string[];
  fetchImpl?: typeof fetch;
};

export type CitizenReceiptLookupRequest = {
  apiBaseUrl: string;
  allowlistedApiBaseUrls: readonly string[];
  receiptId: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
};

const ALLOWED_PROTOCOLS = new Set(['https:', 'http:']);
const CITIZEN_SUBMIT_ENVELOPE_PATH = '/api/v1/envelopes/submit';
const CITIZEN_RECEIPT_PATH_PREFIX = '/api/v1/receipts/';

function normalizeDestination(urlValue: string): string {
  const parsed = new URL(urlValue);
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error('Direct submit destination must use http or https.');
  }
  if (!parsed.hostname) {
    throw new Error('Direct submit destination must include a hostname.');
  }
  parsed.hash = '';
  return parsed.toString();
}

function normalizeApiBaseUrl(urlValue: string): string {
  const normalized = normalizeDestination(urlValue);
  return normalized.replace(/\/+$/, '');
}

function buildApiUrl(apiBaseUrl: string, path: string): string {
  const normalizedBase = normalizeApiBaseUrl(apiBaseUrl);
  return `${normalizedBase}${path.startsWith('/') ? path : `/${path}`}`;
}

export function isAllowlistedDestination(
  destinationUrl: string,
  allowlistedDestinations: readonly string[],
): boolean {
  let normalizedDestination: string;
  try {
    normalizedDestination = normalizeDestination(destinationUrl);
  } catch {
    return false;
  }

  return allowlistedDestinations.some((entry) => {
    try {
      return normalizeDestination(entry) === normalizedDestination;
    } catch {
      return false;
    }
  });
}

export function isAllowlistedApiBaseUrl(
  apiBaseUrl: string,
  allowlistedApiBaseUrls: readonly string[],
): boolean {
  let normalizedBase: string;
  try {
    normalizedBase = normalizeApiBaseUrl(apiBaseUrl);
  } catch {
    return false;
  }

  return allowlistedApiBaseUrls.some((entry) => {
    try {
      return normalizeApiBaseUrl(entry) === normalizedBase;
    } catch {
      return false;
    }
  });
}

export function createDirectSubmitBody(
  signedArtifact: SignedSubmissionArtifact,
  consentToShareSigningPayload = false,
): Record<string, unknown> {
  return {
    signerDid: signedArtifact.signerDid,
    verifyingKey: signedArtifact.verifyingKey,
    signature: signedArtifact.signature,
    payloadHash: signedArtifact.payloadHash,
    signingPayload: consentToShareSigningPayload ? signedArtifact.signingPayload : null,
    signatureScope: signedArtifact.signatureScope,
    algorithm: signedArtifact.algorithm,
    requestId: signedArtifact.requestId ?? null,
  };
}

export async function submitSignedArtifact(
  request: DirectSubmitRequest,
): Promise<DirectSubmitResponse> {
  if (!isAllowlistedDestination(request.destinationUrl, request.allowlistedDestinations)) {
    throw new Error('Destination is not allowlisted for wallet direct submit.');
  }

  const fetchImpl = request.fetchImpl ?? fetch;
  const traceId = crypto.randomUUID();
  const startedAt = Date.now();

  const response = await fetchImpl(request.destinationUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-citizen-wallet-trace-id': traceId,
    },
    body: JSON.stringify(
      createDirectSubmitBody(request.signedArtifact, request.consentToShareSigningPayload ?? false),
    ),
  });

  const latencyMs = Date.now() - startedAt;
  let receiptId: string | null = null;
  let receiptHash: string | null = null;

  try {
    const parsed = (await response.json()) as { receipt?: { receipt_id?: string; receipt_hash?: string } };
    receiptId = typeof parsed.receipt?.receipt_id === 'string' ? parsed.receipt.receipt_id : null;
    receiptHash = typeof parsed.receipt?.receipt_hash === 'string' ? parsed.receipt.receipt_hash : null;
  } catch {
    // upstream may respond with empty body for accepted submissions
  }

  if (!response.ok) {
    throw new Error(`Direct submit failed with status ${response.status} (trace_id=${traceId}).`);
  }

  return {
    traceId,
    status: response.status,
    latencyMs,
    receiptId,
    receiptHash,
  };
}

export async function submitEnvelopeToCitizenNetwork(
  request: CitizenNetworkSubmitRequest,
): Promise<DirectSubmitResponse> {
  if (!request.consentToShareFullPayload) {
    throw new Error('Full-payload submission requires explicit user consent.');
  }
  if (!isAllowlistedApiBaseUrl(request.apiBaseUrl, request.allowlistedApiBaseUrls)) {
    throw new Error('Citizen API base URL is not allowlisted for wallet direct submit.');
  }

  const url = buildApiUrl(request.apiBaseUrl, CITIZEN_SUBMIT_ENVELOPE_PATH);
  const fetchImpl = request.fetchImpl ?? fetch;
  const traceId = crypto.randomUUID();
  const startedAt = Date.now();
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-citizen-wallet-trace-id': traceId,
      ...(request.apiKey ? { 'x-api-key': request.apiKey } : {}),
    },
    body: JSON.stringify(request.envelope),
  });

  const latencyMs = Date.now() - startedAt;
  const payload = await response.json().catch(() => ({} as Record<string, unknown>));
  const receipt = (payload as { receipt?: { receipt_id?: string; finality?: { block_hash?: string } } }).receipt;
  const receiptId = typeof receipt?.receipt_id === 'string' ? receipt.receipt_id : null;
  const receiptHash = typeof receipt?.finality?.block_hash === 'string' ? receipt.finality.block_hash : null;

  if (!response.ok) {
    throw new Error(`Citizen envelope submit failed with status ${response.status} (trace_id=${traceId}).`);
  }

  return {
    traceId,
    status: response.status,
    latencyMs,
    receiptId,
    receiptHash,
  };
}

export async function fetchSubmissionReceipt(request: ReceiptLookupRequest): Promise<unknown> {
  if (!isAllowlistedDestination(request.receiptUrl, request.allowlistedDestinations)) {
    throw new Error('Receipt URL is not allowlisted for wallet direct submit.');
  }

  const fetchImpl = request.fetchImpl ?? fetch;
  const response = await fetchImpl(request.receiptUrl, {
    method: 'GET',
    headers: {
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Receipt lookup failed with status ${response.status}.`);
  }

  return response.json();
}

export async function fetchCitizenReceipt(
  request: CitizenReceiptLookupRequest,
): Promise<unknown> {
  if (!isAllowlistedApiBaseUrl(request.apiBaseUrl, request.allowlistedApiBaseUrls)) {
    throw new Error('Citizen API base URL is not allowlisted for wallet direct submit.');
  }

  const url = buildApiUrl(
    request.apiBaseUrl,
    `${CITIZEN_RECEIPT_PATH_PREFIX}${encodeURIComponent(request.receiptId)}`,
  );

  const fetchImpl = request.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      ...(request.apiKey ? { 'x-api-key': request.apiKey } : {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Citizen receipt lookup failed with status ${response.status}.`);
  }

  return response.json();
}
