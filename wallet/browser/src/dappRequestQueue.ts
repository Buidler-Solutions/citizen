import type { PendingDappSigningRequest } from './dappRequestIsolation';

export type DappRequestConcurrencyMode = 'single_active' | 'queue';

export function hasActivePendingRequest(requests: PendingDappSigningRequest[]): boolean {
  return requests.some((entry) => entry.state === 'pending');
}

export function canAcceptDappSigningRequest(
  requests: PendingDappSigningRequest[],
  mode: DappRequestConcurrencyMode,
): boolean {
  if (mode === 'queue') {
    return true;
  }
  return !hasActivePendingRequest(requests);
}
