import { describe, expect, it } from 'vitest';
import { buildApprovalMetricsSnapshot, type DappRequestAuditEvent } from './dappApprovalMetrics';

describe('buildApprovalMetricsSnapshot', () => {
  it('calculates approval/rejection/timeout rates from latest terminal state per request', () => {
    const events: DappRequestAuditEvent[] = [
      {
        eventId: '1',
        requestId: 'req-1',
        state: 'pending',
        reason: 'queued',
        occurredAt: '2026-04-01T10:00:00.000Z',
      },
      {
        eventId: '2',
        requestId: 'req-1',
        state: 'signed',
        reason: 'signed',
        occurredAt: '2026-04-01T10:00:02.000Z',
      },
      {
        eventId: '3',
        requestId: 'req-2',
        state: 'rejected',
        reason: 'rejected_by_user',
        occurredAt: '2026-04-01T10:00:03.000Z',
      },
      {
        eventId: '4',
        requestId: 'req-3',
        state: 'expired',
        reason: 'request_expired_timeout',
        occurredAt: '2026-04-01T10:00:04.000Z',
      },
    ];

    expect(buildApprovalMetricsSnapshot(events)).toEqual({
      totalRequests: 3,
      approvedCount: 1,
      rejectedCount: 1,
      timeoutCount: 1,
      approvalRate: 0.3333,
      rejectionRate: 0.3333,
      timeoutRate: 0.3333,
      relayDirectSubmitFailureRate: null,
    });
  });

  it('returns zeroed rates when there are no terminal requests', () => {
    const events: DappRequestAuditEvent[] = [
      {
        eventId: '1',
        requestId: 'req-1',
        state: 'pending',
        reason: 'queued',
        occurredAt: '2026-04-01T10:00:00.000Z',
      },
    ];

    expect(buildApprovalMetricsSnapshot(events)).toEqual({
      totalRequests: 0,
      approvedCount: 0,
      rejectedCount: 0,
      timeoutCount: 0,
      approvalRate: 0,
      rejectionRate: 0,
      timeoutRate: 0,
      relayDirectSubmitFailureRate: null,
    });
  });
});
