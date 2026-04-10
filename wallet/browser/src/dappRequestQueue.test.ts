import { describe, expect, it } from 'vitest';
import { canAcceptDappSigningRequest, hasActivePendingRequest } from './dappRequestQueue';
import type { PendingDappSigningRequest } from './dappRequestIsolation';

function request(state: PendingDappSigningRequest['state'], requestId: string): PendingDappSigningRequest {
  return {
    requestId,
    envelope: {
      requestId,
      origin: 'https://demo.citizen.local',
      tabUrl: 'https://demo.citizen.local/forms',
      method: 'ctzn_signCitizenTx',
      payload: { namespace: 'citizen.kyc', operation: 'submit' },
      canonicalPayload: '{"namespace":"citizen.kyc","operation":"submit"}',
      payloadHash: `sha256:${requestId}`,
      createdAt: '2026-01-02T03:04:05.000Z',
      expiresAt: '2026-01-02T03:09:05.000Z',
      riskFlags: [],
      policyChecks: [],
    },
    walletId: 'wallet-1',
    signerDid: 'did:citizen:wallet:1',
    networkId: 'localnode',
    state,
    createdAt: '2026-01-02T03:04:05.000Z',
    updatedAt: '2026-01-02T03:04:05.000Z',
    decidedAt: state === 'pending' ? null : '2026-01-02T03:05:05.000Z',
  };
}

describe('dApp request queue concurrency policy', () => {
  it('detects active pending requests only when state is pending', () => {
    expect(hasActivePendingRequest([request('approved', 'req-1'), request('signed', 'req-2')])).toBe(false);
    expect(hasActivePendingRequest([request('pending', 'req-3'), request('rejected', 'req-4')])).toBe(true);
  });

  it('blocks concurrent signing requests in single_active mode', () => {
    const requests = [request('pending', 'req-1'), request('approved', 'req-2')];
    expect(canAcceptDappSigningRequest(requests, 'single_active')).toBe(false);
  });

  it('allows concurrent queueing when queue mode is selected', () => {
    const requests = [request('pending', 'req-1')];
    expect(canAcceptDappSigningRequest(requests, 'queue')).toBe(true);
  });
});
