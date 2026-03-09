export type WalletKey = {
  id: string;
  label: string;
  publicKey: string;
  createdAt: string;
};

export type Namespace = 'identity.citizen' | 'registry.land' | 'audit.procurement' | 'governance.vote' | 'builder.credits';

export type DraftEntry = {
  namespace: Namespace;
  action: string;
  objectId: string;
  author: string;
  payloadJson: string;
};

export type Submission = {
  id: string;
  status: 'pending' | 'finalized';
  txHash: string;
  blockHeight?: number;
  createdAt: string;
};

export type GovernanceProposal = {
  id: string;
  kind: 'ADD_VALIDATOR' | 'REMOVE_VALIDATOR' | 'UPDATE_PARAMETER';
  description: string;
  status: 'open' | 'finalized';
  finalityHeight?: number;
};

export type AssetDisclosurePosition = {
  issuer: string;
  assetCode: string;
  heldAmount: number;
  trustlineStatus: 'active' | 'closed';
  disclosureMode: 'public' | 'hashed';
  clawbackEnabled: boolean;
  holderNotice: string;
};
