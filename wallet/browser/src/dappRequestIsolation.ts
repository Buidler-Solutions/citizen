import type { DappSigningRequestEnvelope } from './dappSigningRequest';

export const REDACTED_CANONICAL_PAYLOAD = '[redacted_after_decision]';

export type DappRequestState = 'pending' | 'approved' | 'rejected' | 'expired' | 'signed';

export type PendingDappSigningRequest = {
  requestId: string;
  envelope: DappSigningRequestEnvelope;
  walletId: string;
  signerDid: string;
  networkId: 'mainnet' | 'futurenet' | 'testnet' | 'localnode';
  state: DappRequestState;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
};

const DECIDED_STATES: ReadonlySet<DappRequestState> = new Set(['rejected', 'expired', 'signed']);

export function sanitizeEnvelopeForStorage(
  envelope: DappSigningRequestEnvelope,
): DappSigningRequestEnvelope {
  return {
    ...envelope,
    payload: null,
    canonicalPayload: REDACTED_CANONICAL_PAYLOAD,
  };
}

export function sanitizeRequestForStorage(
  request: PendingDappSigningRequest,
  toState: DappRequestState,
): PendingDappSigningRequest {
  if (!DECIDED_STATES.has(toState)) {
    return request;
  }

  return {
    ...request,
    envelope: sanitizeEnvelopeForStorage(request.envelope),
  };
}

export function pruneRetainedRequests(
  requests: PendingDappSigningRequest[],
  nowMs: number,
  retentionMs: number,
): PendingDappSigningRequest[] {
  return requests.filter((request) => {
    if (request.state === 'pending' || request.state === 'approved') {
      return true;
    }

    const anchor = request.decidedAt ?? request.updatedAt;
    const anchorMs = new Date(anchor).getTime();
    if (!Number.isFinite(anchorMs)) {
      return false;
    }

    return nowMs - anchorMs <= retentionMs;
  });
}
