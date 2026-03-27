import type { GovernanceProposal, Submission, WalletKey } from '../types';

const KEYS = 'citizen.wallet.keys.v1';
const RECEIPTS = 'citizen.wallet.receipts.v1';
const GOVERNANCE = 'citizen.wallet.governance.v1';

function read<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function write<T>(key: string, value: T): void {
  localStorage.setItem(key, JSON.stringify(value));
}

export const walletStorage = {
  keys: () => read<WalletKey[]>(KEYS, []),
  setKeys: (keys: WalletKey[]) => write(KEYS, keys),
  receipts: () => read<Submission[]>(RECEIPTS, []),
  setReceipts: (receipts: Submission[]) => write(RECEIPTS, receipts),
  governance: () => read<GovernanceProposal[]>(GOVERNANCE, []),
  setGovernance: (proposals: GovernanceProposal[]) => write(GOVERNANCE, proposals),
};
