import { describe, expect, it } from 'vitest';
import type { DappSigningRequestEnvelope } from './dappSigningRequest';
import {
  pruneRetainedRequests,
  REDACTED_CANONICAL_PAYLOAD,
  sanitizeRequestForStorage,
  type PendingDappSigningRequest,
} from './dappRequestIsolation';

function fixtureEnvelope(): DappSigningRequestEnvelope {
  return {
    requestId: '11111111-1111-1111-1111-111111111111',
    origin: 'https://demo.citizen.local',
    tabUrl: 'https://demo.citizen.local/form',
    method: 'ctzn_signCitizenTx',
    payload: {
      namespace: 'citizen.kyc',
      operation: 'submit',
      metadata: { fullName: 'Alice Example' },
    },
    canonicalPayload: '{"metadata":{"fullName":"Alice Example"},"namespace":"citizen.kyc","operation":"submit"}',
    payloadHash: 'sha256:abc123',
    createdAt: '2026-02-01T10:00:00.000Z',
    expiresAt: '2026-02-01T10:05:00.000Z',
    riskFlags: [],
    policyChecks: [],
  };
}

function fixtureRequest(state: PendingDappSigningRequest['state']): PendingDappSigningRequest {
  return {
    requestId: '11111111-1111-1111-1111-111111111111',
    envelope: fixtureEnvelope(),
    state,
    createdAt: '2026-02-01T10:00:00.000Z',
    updatedAt: '2026-02-01T10:00:00.000Z',
    decidedAt: null,
  };
}

describe('dApp request isolation storage helpers', () => {
  it('redacts canonical payload and raw payload once a request reaches decided state', () => {
    const pending = fixtureRequest('pending');
    const signed = sanitizeRequestForStorage({ ...pending, state: 'signed' }, 'signed');

    expect(signed.envelope.payload).toBeNull();
    expect(signed.envelope.canonicalPayload).toBe(REDACTED_CANONICAL_PAYLOAD);
    expect(signed.envelope.payloadHash).toBe('sha256:abc123');
  });

  it('keeps pending request payloads intact for user review prior to approval', () => {
    const pending = fixtureRequest('pending');
    const unchanged = sanitizeRequestForStorage(pending, 'approved');

    expect(unchanged.envelope.payload).toEqual({
      namespace: 'citizen.kyc',
      operation: 'submit',
      metadata: { fullName: 'Alice Example' },
    });
    expect(unchanged.envelope.canonicalPayload).toContain('Alice Example');
  });

  it('prunes decided requests older than retention window and keeps active states', () => {
    const nowMs = new Date('2026-03-01T00:00:00.000Z').getTime();
    const retentionMs = 24 * 60 * 60 * 1000;

    const staleSigned: PendingDappSigningRequest = {
      ...fixtureRequest('signed'),
      updatedAt: '2026-02-20T00:00:00.000Z',
      decidedAt: '2026-02-20T00:00:00.000Z',
    };

    const freshRejected: PendingDappSigningRequest = {
      ...fixtureRequest('rejected'),
      requestId: '22222222-2222-2222-2222-222222222222',
      updatedAt: '2026-02-28T12:00:00.000Z',
      decidedAt: '2026-02-28T12:00:00.000Z',
    };

    const activePending: PendingDappSigningRequest = {
      ...fixtureRequest('pending'),
      requestId: '33333333-3333-3333-3333-333333333333',
      updatedAt: '2026-02-10T00:00:00.000Z',
    };

    const kept = pruneRetainedRequests([staleSigned, freshRejected, activePending], nowMs, retentionMs);
    expect(kept).toHaveLength(2);
    expect(kept.map((entry) => entry.requestId)).toEqual([
      '22222222-2222-2222-2222-222222222222',
      '33333333-3333-3333-3333-333333333333',
    ]);
  });
});
