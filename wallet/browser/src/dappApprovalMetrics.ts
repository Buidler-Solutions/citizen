export type DappRequestAuditState = 'pending' | 'approved' | 'rejected' | 'expired' | 'signed';

export type DappRequestAuditEvent = {
  eventId: string;
  requestId: string;
  state: DappRequestAuditState;
  reason: string;
  occurredAt: string;
};

export type ApprovalMetricsSnapshot = {
  totalRequests: number;
  approvedCount: number;
  rejectedCount: number;
  timeoutCount: number;
  approvalRate: number;
  rejectionRate: number;
  timeoutRate: number;
  relayDirectSubmitFailureRate: number | null;
};

function safeRate(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }
  return Number((numerator / denominator).toFixed(4));
}

export function buildApprovalMetricsSnapshot(events: DappRequestAuditEvent[]): ApprovalMetricsSnapshot {
  const latestByRequest = new Map<string, DappRequestAuditEvent>();
  for (const event of events) {
    const previous = latestByRequest.get(event.requestId);
    if (!previous) {
      latestByRequest.set(event.requestId, event);
      continue;
    }
    if (new Date(event.occurredAt).getTime() >= new Date(previous.occurredAt).getTime()) {
      latestByRequest.set(event.requestId, event);
    }
  }

  const terminalEvents = Array.from(latestByRequest.values()).filter((event) => (
    event.state === 'signed' || event.state === 'rejected' || event.state === 'expired'
  ));

  const totalRequests = terminalEvents.length;
  const approvedCount = terminalEvents.filter((event) => event.state === 'signed').length;
  const rejectedCount = terminalEvents.filter((event) => event.state === 'rejected').length;
  const timeoutCount = terminalEvents.filter((event) => event.state === 'expired').length;

  return {
    totalRequests,
    approvedCount,
    rejectedCount,
    timeoutCount,
    approvalRate: safeRate(approvedCount, totalRequests),
    rejectionRate: safeRate(rejectedCount, totalRequests),
    timeoutRate: safeRate(timeoutCount, totalRequests),
    relayDirectSubmitFailureRate: null,
  };
}
