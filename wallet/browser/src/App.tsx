import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildStrictBuilderCreditChecklist,
  createMultisigGrantDraft,
  createSponsorUsageDraft,
} from './builderCreditDraft';
import {
  getApprovalUiRolloutStageFromEnv,
  isApprovalUiEnabled,
  type ApprovalUiRolloutStage,
} from './rollout';
import { canonicalJson, sha256DigestHex } from './canonical';

type WalletState = {
  account: string;
  network: NetworkId;
  lastRequest: {
    requestedAt: string;
    origin: string;
    method: string;
    params: unknown[];
    account: string;
  } | null;
};

type ActivityEntry = {
  requestedAt: string;
  origin: string;
  method: string;
  params: unknown[];
  account: string;
};

type VaultWallet = {
  id: string;
  name: string;
  signerDid: string;
  hasMnemonic: boolean;
  mnemonicWordCount?: MnemonicWordCount | null;
  createdAt: string;
  isActive: boolean;
};

type PendingDappRequest = {
  requestId: string;
  origin: {
    origin: string;
    tabUrl: string | null;
  };
  method: 'ctzn_signCitizenTx';
  payload: {
    canonicalJson: string;
    hash: string;
  };
  walletId: string;
  signerDid: string;
  networkId: NetworkId;
  createdAt: string;
  expiresAt: string;
  riskFlags: string[];
  policyChecks: Array<{
    code: string;
    message: string;
  }>;
  state: 'pending' | 'approved' | 'rejected' | 'expired' | 'signed';
};

type OriginPermission = {
  origin: string;
  permission: 'prompt' | 'blocked';
  updatedAt: string;
};

type DirectSubmitConfig = {
  defaultDestination: string;
  allowlistedDestinations: readonly string[];
  allowlistedApiBaseUrls?: readonly string[];
};

type DirectSubmitReceipt = {
  requestId: string;
  payloadHash: string | null;
  walletId: string;
  signerDid: string;
  networkId: NetworkId;
  destinationUrl: string;
  traceId: string;
  status: number;
  latencyMs: number;
  receiptId: string | null;
  receiptHash: string | null;
  submittedAt: string;
};

type DecryptedAttachment = {
  base64: string;
  name: string;
  mimeType: string;
  sha256?: string;
};

type ProtocolKeyMaterial = {
  signer: {
    did: string;
    verifyingKey: string;
    algorithm: string;
  };
  reader: {
    readerDid: string;
    publicKeyHex: string;
    algorithm: string;
  };
};

type ProtocolKeypairsExport = {
  signer_did: string;
  signer_algorithm: string;
  signer_ed25519_public_key_hex: string;
  signer_ed25519_private_key_hex: string;
  reader_did: string;
  reader_algorithm: string;
  reader_x25519_public_key_hex: string;
  reader_x25519_private_key_hex: string;
  mnemonic_phrase: string | null;
  derivation_path: string | null;
};


type ApprovalMetrics = {
  totalRequests: number;
  approvedCount: number;
  rejectedCount: number;
  timeoutCount: number;
  approvalRate: number;
  rejectionRate: number;
  timeoutRate: number;
  relayDirectSubmitFailureRate: number | null;
};

type ProfileDetails = {
  fullName: string;
  email: string;
  address: string;
  profession: string;
  kycVerified: boolean;
};

type ComposeDraftCollectedSignature = {
  signer: string;
  signature: string;
};

type ComposeMultisigDraft = {
  schema: 'citizen.compose.multisig-draft.v1';
  canonical_payload: string;
  canonical_payload_hash: string;
  policy: {
    signature_scope: 'canonical_payload_v1';
    threshold: number;
    allowed_signers: string[];
    require_author_signature: boolean;
  };
  collected_signatures: ComposeDraftCollectedSignature[];
};

type TabId = 'activity' | 'decrypt' | 'compose' | 'vault' | 'security' | 'profile';

type NetworkId = 'mainnet' | 'futurenet' | 'testnet' | 'localnode';
type MnemonicWordCount = 12 | 24;
type NetworkLiveness = Record<NetworkId, boolean>;

function detectMnemonicWordCount(phrase: string): MnemonicWordCount | null {
  const words = phrase.trim().split(/\s+/).filter(Boolean).length;
  if (words === 12 || words === 24) {
    return words;
  }
  return null;
}

const NETWORK_OPTIONS: { id: NetworkId; label: string }[] = [
  { id: 'mainnet', label: 'Mainnet' },
  { id: 'futurenet', label: 'Futurenet' },
  { id: 'testnet', label: 'Testnet' },
  { id: 'localnode', label: 'Local Node' },
];


const EXPLORER_BASE_URL_BY_NETWORK: Record<NetworkId, string> = {
  mainnet: 'https://explorer.citizenprotocol.io',
  futurenet: 'https://futurenet-explorer.citizenprotocol.io',
  testnet: 'https://testnet-explorer.citizenprotocol.io',
  localnode: 'http://localhost:8885',
};

function normalizeExplorerHashQueryValue(value: string): string {
  return value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
}

function buildExplorerDataHashSearchHref(network: NetworkId, receiptHash: string): string {
  const explorerBase = EXPLORER_BASE_URL_BY_NETWORK[network] ?? EXPLORER_BASE_URL_BY_NETWORK.localnode;
  const normalizedHash = normalizeExplorerHashQueryValue(receiptHash);
  const query = encodeURIComponent(`sha256:${normalizedHash}`);
  return `${explorerBase.replace(/\/$/, '')}/data-hash?q=${query}`;
}

const NAV_ITEMS: { id: TabId; label: string }[] = [
  { id: 'activity', label: 'Activity' },
  { id: 'decrypt', label: 'Decrypt' },
  { id: 'compose', label: 'Compose' },
  { id: 'vault', label: 'Vault' },
  { id: 'security', label: 'Security' },
  { id: 'profile', label: 'Profile' },
];

type WalletResponse = {
  ok: boolean;
  result?: unknown;
  error?: string;
};

const STORAGE_KEY = 'citizen.browser.wallet.v1';
const LAST_REQUEST_KEY = 'citizen.browser.wallet.last_request.v1';
const PROFILE_KEY = 'citizen.browser.wallet.profile.v1';
const DAPP_PENDING_REQUESTS_KEY = 'citizen.browser.wallet.dapp_pending_requests.v1';
const DIRECT_SUBMIT_RECEIPTS_KEY = 'citizen.browser.wallet.direct_submit_receipts.v1';

const APPROVAL_UI_ROLLOUT_STAGE = getApprovalUiRolloutStageFromEnv();
const CREDENTIAL_REVEAL_TTL_MS = 60_000;

function rolloutLabel(stage: ApprovalUiRolloutStage): string {
  if (stage === 'general') {
    return 'General';
  }
  if (stage === 'beta') {
    return 'Beta';
  }
  if (stage === 'disabled') {
    return 'Disabled';
  }
  return 'Internal';
}

const SPONSORSHIP_PRESETS = {
  article: {
    grantScope: 'content.article',
    sponsoredDid: 'did:ledger:app:citizen-blog',
    sponsorshipId: 'sponsor-usage-article-001',
  },
  governance: {
    grantScope: 'governance.vote',
    sponsoredDid: 'did:ledger:app:citizen-governance',
    sponsorshipId: 'sponsor-usage-governance-001',
  },
} as const;

function mask(value: string) {
  if (value.length < 14) {
    return value;
  }
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function renderPayloadSummary(canonicalJson: string): Array<{ label: string; value: string }> {
  try {
    const parsed = JSON.parse(canonicalJson) as Record<string, unknown>;
    return Object.entries(parsed).map(([key, value]) => ({
      label: key,
      value: typeof value === 'string' ? value : JSON.stringify(value),
    }));
  } catch {
    return [{ label: 'payload', value: canonicalJson }];
  }
}

async function callWallet(method: string, params?: unknown[]): Promise<WalletResponse> {
  try {
    const response = await chrome.runtime.sendMessage({ method, params }) as WalletResponse | undefined;
    if (!response) {
      return { ok: false, error: 'No response from wallet background service.' };
    }
    return response;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown extension messaging error.';
    return { ok: false, error: `Wallet communication error: ${reason}` };
  }
}

export function App() {
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>('activity');
  const [menuOpen, setMenuOpen] = useState(false);
  const [hasStoredWallet, setHasStoredWallet] = useState(false);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [vaultWallets, setVaultWallets] = useState<VaultWallet[]>([]);
  const [pendingDappRequests, setPendingDappRequests] = useState<PendingDappRequest[]>([]);
  const [originPermissions, setOriginPermissions] = useState<OriginPermission[]>([]);
  const [approvalMetrics, setApprovalMetrics] = useState<ApprovalMetrics | null>(null);
  const [showRawPayloadByRequest, setShowRawPayloadByRequest] = useState<Record<string, boolean>>({});
  const [showFullUrlByRequest, setShowFullUrlByRequest] = useState<Record<string, boolean>>({});
  const [directSubmitConfig, setDirectSubmitConfig] = useState<DirectSubmitConfig | null>(null);
  const [directSubmitDestination, setDirectSubmitDestination] = useState('');
  const [confirmDirectSubmitDestination, setConfirmDirectSubmitDestination] = useState(false);
  const [consentShareSigningPayload, setConsentShareSigningPayload] = useState(false);
  const [directSubmitReceipts, setDirectSubmitReceipts] = useState<DirectSubmitReceipt[]>([]);
  const [profile, setProfile] = useState<ProfileDetails>({
    fullName: '',
    email: '',
    address: '',
    profession: '',
    kycVerified: false,
  });
  const [composeMessage, setComposeMessage] = useState('Authorize Citizen transaction payload v1');
  const [composeSignature, setComposeSignature] = useState('');
  const [decryptAuthorPublicKeyHex, setDecryptAuthorPublicKeyHex] = useState('');
  const [decryptWrappedDekHex, setDecryptWrappedDekHex] = useState('');
  const [decryptNonceHex, setDecryptNonceHex] = useState('');
  const [decryptCiphertextHex, setDecryptCiphertextHex] = useState('');
  const [decryptTransactionJson, setDecryptTransactionJson] = useState('');
  const [decryptedPayload, setDecryptedPayload] = useState('');
  const [decryptedAttachment, setDecryptedAttachment] = useState<DecryptedAttachment | null>(null);
  const [protocolKeyMaterial, setProtocolKeyMaterial] = useState<ProtocolKeyMaterial | null>(null);
  const [state, setState] = useState<WalletState>({
    account: 'Not initialized',
    network: 'mainnet',
    lastRequest: null,
  });
  const [passwordInput, setPasswordInput] = useState('');
  const [needsPasswordSetup, setNeedsPasswordSetup] = useState(false);
  const [locked, setLocked] = useState(false);
  const [status, setStatus] = useState('');
  const [networkLiveness, setNetworkLiveness] = useState<NetworkLiveness>({
    mainnet: true,
    futurenet: true,
    testnet: true,
    localnode: true,
  });
  const [secretPassword, setSecretPassword] = useState('');
  const [protocolKeypairs, setProtocolKeypairs] = useState<ProtocolKeypairsExport | null>(null);
  const [mnemonicPassword, setMnemonicPassword] = useState('');
  const [mnemonicPhrase, setMnemonicPhrase] = useState('');
  const [importMnemonicPhrase, setImportMnemonicPhrase] = useState('');
  const [derivationPath, setDerivationPath] = useState("m/44'/930'/0'/0'/0'");
  const [mnemonicWordCount, setMnemonicWordCount] = useState<MnemonicWordCount>(12);
  const [grantId, setGrantId] = useState('grant:builder:alpha');
  const [sponsorDid, setSponsorDid] = useState('did:ledger:builder:alpha');
  const [sponsoredDid, setSponsoredDid] = useState('did:ledger:app:citizen-blog');
  const [sponsorshipId, setSponsorshipId] = useState('sponsor-usage-001');
  const [sponsorUsageAmount, setSponsorUsageAmount] = useState('1');
  const [grantAmount, setGrantAmount] = useState('100');
  const [multisigThreshold, setMultisigThreshold] = useState('2');
  const [grantScope, setGrantScope] = useState('content.article');
  const [draftErrors, setDraftErrors] = useState<string[]>([]);
  const [draftPayload, setDraftPayload] = useState('');
  const [composeAllowedSigners, setComposeAllowedSigners] = useState('');
  const [composeDraftJson, setComposeDraftJson] = useState('');
  const [composeDraftSignerDid, setComposeDraftSignerDid] = useState('');
  const [composeDraftSignerSignature, setComposeDraftSignerSignature] = useState('');
  const [composeMultisigDraft, setComposeMultisigDraft] = useState<ComposeMultisigDraft | null>(null);

  const checklist = useMemo(
    () =>
      buildStrictBuilderCreditChecklist({
        authorDid: protocolKeyMaterial?.signer.did ?? state.account,
        creditGrantId: grantId,
        sponsorBuilderId: sponsorDid,
        sponsoredDid,
        sponsorshipId,
        sponsorUsageAmount,
        grantAmount,
        multisigThreshold,
        grantScope,
      }),
    [grantAmount, grantId, grantScope, multisigThreshold, protocolKeyMaterial?.signer.did, sponsorDid, sponsorUsageAmount, sponsoredDid, sponsorshipId, state.account],
  );

  const composeThreshold = useMemo(() => {
    const parsed = Number.parseInt(multisigThreshold, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
  }, [multisigThreshold]);
  const composeSignerOptions = useMemo(
    () => composeAllowedSigners.split(',').map((entry) => entry.trim()).filter(Boolean),
    [composeAllowedSigners],
  );
  const composeCollectedSignerCount = composeMultisigDraft?.collected_signatures.length ?? 0;
  const composeDraftThreshold = composeMultisigDraft?.policy.threshold ?? composeThreshold;
  const composeThresholdSatisfied = composeCollectedSignerCount >= composeDraftThreshold;

  const refreshState = useCallback(async () => {
    setIsLoading(true);
    try {
      const stored = await chrome.storage.local.get([STORAGE_KEY, LAST_REQUEST_KEY, PROFILE_KEY]);
      const lastRequest = stored[LAST_REQUEST_KEY] as WalletState['lastRequest'];

      const walletExists = await callWallet('wallet_hasStoredWallet');
      const hasWallet = walletExists.ok ? Boolean(walletExists.result) : false;
      setHasStoredWallet(hasWallet);

      const passwordSet = await callWallet('wallet_isPasswordSet');
      setNeedsPasswordSetup(passwordSet.ok ? !(passwordSet.result as boolean) : true);

      const unlocked = await callWallet('wallet_isUnlocked');
      const isUnlocked = unlocked.ok ? (unlocked.result as boolean) : false;
      setLocked(!isUnlocked);

      const selectedNetwork = await callWallet('wallet_getNetwork');
      const network = selectedNetwork.ok
        ? (selectedNetwork.result as NetworkId)
        : 'mainnet';
      const livenessResponse = await callWallet('wallet_getNetworkLiveness');
      const liveNetworks = livenessResponse.ok && livenessResponse.result && typeof livenessResponse.result === 'object'
        ? livenessResponse.result as NetworkLiveness
        : null;
      if (liveNetworks) {
        setNetworkLiveness(liveNetworks);
        if (!liveNetworks[network]) {
          setStatus(`Selected network (${network}) is offline. Switch to a live network to continue transactions.`);
        }
      }

      const profileDraft = stored[PROFILE_KEY] as Partial<ProfileDetails> | undefined;
      if (profileDraft) {
        setProfile((current) => ({ ...current, ...profileDraft }));
      }

      const activityResponse = await callWallet('wallet_getActivity');
      if (activityResponse.ok && Array.isArray(activityResponse.result)) {
        setActivity(activityResponse.result as ActivityEntry[]);
      }

      const vaultResponse = await callWallet('wallet_listVault');
      if (vaultResponse.ok && Array.isArray(vaultResponse.result)) {
        const wallets = vaultResponse.result as VaultWallet[];
        setVaultWallets(wallets);
        const activeMnemonicType = wallets.find((wallet) => wallet.isActive)?.mnemonicWordCount;
        if (activeMnemonicType === 12 || activeMnemonicType === 24) {
          setMnemonicWordCount(activeMnemonicType);
        }
      }

      const pendingResponse = await callWallet('wallet_getPendingDappRequests');
      if (pendingResponse.ok && Array.isArray(pendingResponse.result)) {
        setPendingDappRequests(pendingResponse.result as PendingDappRequest[]);
      }
      const permissionsResponse = await callWallet('wallet_getOriginPermissions');
      if (permissionsResponse.ok && Array.isArray(permissionsResponse.result)) {
        setOriginPermissions(permissionsResponse.result as OriginPermission[]);
      }

      const metricsResponse = await callWallet('wallet_getApprovalMetrics');
      if (metricsResponse.ok && metricsResponse.result && typeof metricsResponse.result === 'object') {
        setApprovalMetrics(metricsResponse.result as ApprovalMetrics);
      }

      const directSubmitConfigResponse = await callWallet('wallet_getDirectSubmitConfig');
      if (directSubmitConfigResponse.ok && directSubmitConfigResponse.result && typeof directSubmitConfigResponse.result === 'object') {
        const config = directSubmitConfigResponse.result as DirectSubmitConfig;
        setDirectSubmitConfig(config);
        setDirectSubmitDestination(config.defaultDestination);
      }

      const directSubmitReceiptsResponse = await callWallet('wallet_getDirectSubmitReceipts');
      if (directSubmitReceiptsResponse.ok && Array.isArray(directSubmitReceiptsResponse.result)) {
        setDirectSubmitReceipts(directSubmitReceiptsResponse.result as DirectSubmitReceipt[]);
      }

      if (!hasWallet || !isUnlocked) {
        setProtocolKeyMaterial(null);
        setState({
          account: hasWallet ? (isUnlocked ? 'Ready' : 'Locked') : 'Wallet not configured',
          network,
          lastRequest: lastRequest ?? null,
        });
        if (!isUnlocked) {
          setProtocolKeypairs(null);
          setComposeSignature('');
        }
        return;
      }

      const protocolMaterialResponse = await callWallet('ctzn_getCitizenKeyMaterial');
      if (protocolMaterialResponse.ok && protocolMaterialResponse.result && typeof protocolMaterialResponse.result === 'object') {
        const material = protocolMaterialResponse.result as ProtocolKeyMaterial;
        setProtocolKeyMaterial(material);
        setState({ account: material.signer.did, network, lastRequest: lastRequest ?? null });
      } else {
        setProtocolKeyMaterial(null);
        setState({ account: 'Unavailable', network, lastRequest: lastRequest ?? null });
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshState();
  }, [refreshState]);

  useEffect(() => {
    if (activeTab !== 'security' && protocolKeypairs) {
      setProtocolKeypairs(null);
      setSecretPassword('');
    }
  }, [activeTab, protocolKeypairs]);

  useEffect(() => {
    if (!protocolKeypairs) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setProtocolKeypairs(null);
      setStatus('Protocol wallet credentials auto-hidden after 60 seconds.');
    }, CREDENTIAL_REVEAL_TTL_MS);
    return () => window.clearTimeout(timeoutId);
  }, [protocolKeypairs]);

  useEffect(() => {
    const handleStorageChange: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (changes, areaName) => {
      if (areaName !== 'local') {
        return;
      }
      if (!changes[DAPP_PENDING_REQUESTS_KEY] && !changes[DIRECT_SUBMIT_RECEIPTS_KEY]) {
        return;
      }
      void refreshState();
    };

    chrome.storage.onChanged.addListener(handleStorageChange);
    return () => {
      chrome.storage.onChanged.removeListener(handleStorageChange);
    };
  }, [refreshState]);

  const pendingRequests = useMemo(
    () => pendingDappRequests.filter((entry) => entry.state === 'pending'),
    [pendingDappRequests],
  );
  const activeWallet = useMemo(
    () => vaultWallets.find((wallet) => wallet.isActive) ?? null,
    [vaultWallets],
  );
  const activeSignerDid = activeWallet?.signerDid ?? null;
  const signedRequests = useMemo(
    () => pendingDappRequests.filter((entry) => entry.state === 'signed'),
    [pendingDappRequests],
  );
  const currentNetworkSignedRequests = useMemo(
    () => signedRequests.filter((entry) => entry.networkId === state.network),
    [signedRequests, state.network],
  );
  const visibleSignedRequests = useMemo(
    () =>
      currentNetworkSignedRequests.filter(
        (entry) => !activeSignerDid || entry.signerDid === activeSignerDid,
      ),
    [activeSignerDid, currentNetworkSignedRequests],
  );
  const visibleDirectSubmitReceipts = useMemo(
    () =>
      directSubmitReceipts.filter(
        (receipt) => receipt.networkId === state.network
          && (!activeSignerDid || receipt.signerDid === activeSignerDid),
      ),
    [activeSignerDid, directSubmitReceipts, state.network],
  );
  const latestReceiptByRequestId = useMemo(() => {
    const pairs = visibleDirectSubmitReceipts
      .filter((receipt) => receipt.requestId.length > 0)
      .map((receipt) => [receipt.requestId, receipt] as const);
    return new Map<string, DirectSubmitReceipt>(pairs);
  }, [visibleDirectSubmitReceipts]);
  const latestReceiptByPayloadHash = useMemo(() => {
    const pairs = visibleDirectSubmitReceipts
      .filter((receipt) => typeof receipt.payloadHash === 'string' && receipt.payloadHash.length > 0)
      .map((receipt) => [receipt.payloadHash as string, receipt] as const);
    return new Map<string, DirectSubmitReceipt>(pairs);
  }, [visibleDirectSubmitReceipts]);
  const approvalUiEnabled = isApprovalUiEnabled(APPROVAL_UI_ROLLOUT_STAGE);
  const selectedNetworkIsLive = networkLiveness[state.network];
  const modalNetworkOptions = useMemo(
    () =>
      NETWORK_OPTIONS.filter((option) => networkLiveness[option.id] || option.id === state.network),
    [networkLiveness, state.network],
  );

  const handleNetworkUnavailable = (message?: string) => {
    setStatus(message ?? 'Selected network is offline. Switch to a live network to continue.');
  };

  const handlePasswordSubmit = async () => {
    setStatus('');
    if (!passwordInput) {
      setStatus('Enter a password first.');
      return;
    }

    const method = needsPasswordSetup ? 'wallet_setPassword' : 'wallet_unlock';
    const result = await callWallet(method, [passwordInput]);
    if (!result.ok) {
      setStatus(result.error ?? 'Password action failed.');
      return;
    }

    setPasswordInput('');
    setStatus(needsPasswordSetup ? 'Password set. Wallet unlocked.' : 'Wallet unlocked.');
    await refreshState();
  };

  const ensurePasswordSetupIfNeeded = async () => {
    if (!needsPasswordSetup) {
      return true;
    }
    if (!passwordInput) {
      setStatus('Set a password before creating or importing a wallet.');
      return false;
    }
    const result = await callWallet('wallet_setPassword', [passwordInput]);
    if (!result.ok) {
      setStatus(result.error ?? 'Unable to set wallet password.');
      return false;
    }
    setPasswordInput('');
    return true;
  };

  const handleLock = async () => {
    const result = await callWallet('wallet_lock');
    setStatus(result.ok ? 'Wallet locked.' : result.error ?? 'Failed to lock wallet.');
    setMenuOpen(false);
    setProtocolKeypairs(null);
    setSecretPassword('');
    setComposeSignature('');
    await refreshState();
  };

  const handleRevealSecret = async () => {
    setStatus('');
    if (!secretPassword) {
      setStatus('Enter password to view wallet protocol credentials.');
      return;
    }

    const result = await callWallet('wallet_exportProtocolKeypairs', [secretPassword]);
    if (!result.ok || typeof result.result !== 'object' || result.result === null) {
      setStatus(result.error ?? 'Unable to reveal wallet protocol credentials.');
      return;
    }

    setProtocolKeypairs(result.result as ProtocolKeypairsExport);
    setSecretPassword('');
    setStatus('Protocol wallet credentials revealed. Keep them private and rotate if exposed.');
  };

  const handleCopySecret = async () => {
    if (!protocolKeypairs) {
      return;
    }
    await navigator.clipboard.writeText(JSON.stringify(protocolKeypairs, null, 2));
    setStatus('Protocol wallet credentials copied to clipboard.');
  };

  const handleRevealMnemonic = async () => {
    setStatus('');
    if (!mnemonicPassword) {
      setStatus('Enter password to view seed phrase.');
      return;
    }

    const result = await callWallet('wallet_exportMnemonic', [mnemonicPassword]);
    if (!result.ok || typeof result.result !== 'object' || result.result === null) {
      setStatus(result.error ?? 'Unable to reveal seed phrase.');
      return;
    }

    const value = result.result as { mnemonicPhrase?: string; derivationPath?: string };
    if (!value.mnemonicPhrase) {
      setStatus('Mnemonic phrase is unavailable for this wallet.');
      return;
    }
    setMnemonicPhrase(value.mnemonicPhrase);
    const detectedWordCount = detectMnemonicWordCount(value.mnemonicPhrase);
    if (detectedWordCount) {
      setMnemonicWordCount(detectedWordCount);
    }
    if (value.derivationPath) {
      setDerivationPath(value.derivationPath);
    }
    setMnemonicPassword('');
    setStatus('Seed phrase revealed. Store offline only.');
  };

  const handleImportMnemonic = async () => {
    setStatus('');
    if (!(await ensurePasswordSetupIfNeeded())) {
      return;
    }
    if (!importMnemonicPhrase.trim()) {
      setStatus('Enter a seed phrase to import.');
      return;
    }

    const result = await callWallet('wallet_importMnemonic', [importMnemonicPhrase, derivationPath]);
    if (!result.ok) {
      setStatus(result.error ?? 'Failed to import seed phrase.');
      return;
    }

    setMnemonicPhrase('');
    setImportMnemonicPhrase('');
    const importedWordCount = detectMnemonicWordCount(importMnemonicPhrase);
    if (importedWordCount) {
      setMnemonicWordCount(importedWordCount);
    }
    setStatus('Seed phrase imported. Wallet account updated.');
    await refreshState();
  };

  const handleGenerateMnemonicWallet = async () => {
    setStatus('');
    if (!(await ensurePasswordSetupIfNeeded())) {
      return;
    }
    const result = await callWallet('wallet_generateMnemonicWallet', [derivationPath, mnemonicWordCount]);
    if (!result.ok || typeof result.result !== 'object' || result.result === null) {
      setStatus(result.error ?? 'Failed to generate wallet.');
      return;
    }

    const value = result.result as { mnemonicPhrase?: string };
    setMnemonicPhrase(value.mnemonicPhrase ?? '');
    setImportMnemonicPhrase('');
    setStatus('Generated new wallet + seed phrase. Back it up now.');
    await refreshState();
  };

  const handleNetworkChange = async (network: NetworkId) => {
    const result = await callWallet('wallet_setNetwork', [network]);
    if (!result.ok) {
      setStatus(result.error ?? 'Failed to change network.');
      return;
    }
    setStatus(`Network switched to ${network}.`);
    await refreshState();
  };

  const handleSetActiveWallet = async (walletId: string) => {
    const result = await callWallet('wallet_setActiveWallet', [walletId]);
    if (!result.ok) {
      setStatus(result.error ?? 'Unable to activate wallet.');
      return;
    }
    setStatus('Active wallet switched.');
    await refreshState();
  };

  const handleSignComposed = async () => {
    if (!composeMessage.trim()) {
      setStatus('Compose a transaction payload first.');
      return;
    }
    const result = await callWallet('ctzn_signCitizenTx', [{ message: composeMessage }]);
    if (!result.ok || !result.result || typeof result.result !== 'object') {
      if (result.error?.includes('ERR_NETWORK_UNAVAILABLE')) {
        handleNetworkUnavailable(result.error);
        return;
      }
      setStatus(result.error ?? 'Unable to sign composed transaction payload.');
      return;
    }
    const payload = result.result as { signature?: string };
    setComposeSignature(payload.signature ?? '');
    setStatus('Composed payload signed successfully.');
    await refreshState();
  };

  const handleInitComposeMultisigDraft = async () => {
    setStatus('');
    if (!composeMessage.trim()) {
      setStatus('Compose a transaction payload first.');
      return;
    }
    const uniqueAllowedSigners = Array.from(new Set(composeSignerOptions));
    if (uniqueAllowedSigners.length < composeThreshold) {
      setStatus('Allowed signers count must be greater than or equal to threshold.');
      return;
    }
    const signerDid = protocolKeyMaterial?.signer.did ?? state.account;
    const canonicalPayload = canonicalJson({
      author: signerDid,
      message: composeMessage.trim(),
    });
    const canonicalPayloadHash = await sha256DigestHex(canonicalPayload);
    const draft: ComposeMultisigDraft = {
      schema: 'citizen.compose.multisig-draft.v1',
      canonical_payload: canonicalPayload,
      canonical_payload_hash: canonicalPayloadHash,
      policy: {
        signature_scope: 'canonical_payload_v1',
        threshold: composeThreshold,
        allowed_signers: uniqueAllowedSigners,
        require_author_signature: true,
      },
      collected_signatures: [],
    };
    setComposeMultisigDraft(draft);
    setComposeDraftJson(JSON.stringify(draft, null, 2));
    setComposeDraftSignerDid('');
    setComposeDraftSignerSignature('');
    setStatus('Multisig draft initialized. Canonical payload is now immutable for this draft.');
  };

  const handleImportComposeMultisigDraft = async () => {
    setStatus('');
    if (!composeDraftJson.trim()) {
      setStatus('Paste a multisig draft JSON document to import.');
      return;
    }
    try {
      const parsed = JSON.parse(composeDraftJson) as ComposeMultisigDraft;
      if (parsed.schema !== 'citizen.compose.multisig-draft.v1') {
        setStatus('Unsupported compose draft schema.');
        return;
      }
      if (parsed.policy.signature_scope !== 'canonical_payload_v1') {
        setStatus('Draft signature_scope must be canonical_payload_v1.');
        return;
      }
      const expectedHash = await sha256DigestHex(parsed.canonical_payload);
      if (expectedHash !== parsed.canonical_payload_hash) {
        setStatus('Draft integrity check failed: canonical_payload_hash mismatch.');
        return;
      }
      const signerSet = new Set(parsed.collected_signatures.map((entry) => entry.signer));
      if (signerSet.size !== parsed.collected_signatures.length) {
        setStatus('Draft integrity check failed: duplicate signer in collected_signatures.');
        return;
      }
      setComposeMultisigDraft(parsed);
      setComposeDraftJson(JSON.stringify(parsed, null, 2));
      setStatus('Multisig draft imported successfully.');
    } catch (error) {
      setStatus(error instanceof Error ? `Invalid draft JSON: ${error.message}` : 'Invalid draft JSON.');
    }
  };

  const handleAppendComposeDraftSignature = async () => {
    setStatus('');
    if (!composeMultisigDraft) {
      setStatus('Initialize or import a multisig draft first.');
      return;
    }
    const signer = composeDraftSignerDid.trim();
    const signature = composeDraftSignerSignature.trim();
    if (!signer || !signature) {
      setStatus('Provide signer DID and signature to append a co-signature.');
      return;
    }
    if (!composeMultisigDraft.policy.allowed_signers.includes(signer)) {
      setStatus('Signer is not in the draft allowed_signers policy.');
      return;
    }
    if (composeMultisigDraft.collected_signatures.some((entry) => entry.signer === signer)) {
      setStatus('Signer already collected for this draft.');
      return;
    }
    const updatedDraft: ComposeMultisigDraft = {
      ...composeMultisigDraft,
      collected_signatures: [
        ...composeMultisigDraft.collected_signatures,
        { signer, signature },
      ],
    };
    const expectedHash = await sha256DigestHex(updatedDraft.canonical_payload);
    if (expectedHash !== updatedDraft.canonical_payload_hash) {
      setStatus('Draft mutation rejected: canonical payload hash mismatch.');
      return;
    }
    setComposeMultisigDraft(updatedDraft);
    setComposeDraftJson(JSON.stringify(updatedDraft, null, 2));
    setComposeDraftSignerDid('');
    setComposeDraftSignerSignature('');
    setStatus('Signer appended to multisig draft.');
  };

  const handleFinalizeComposeMultisigDraft = () => {
    setStatus('');
    if (!composeMultisigDraft) {
      setStatus('Initialize or import a multisig draft first.');
      return;
    }
    if (composeMultisigDraft.collected_signatures.length < composeMultisigDraft.policy.threshold) {
      setStatus('Threshold not satisfied. Collect more signatures before finalizing.');
      return;
    }
    const finalizedEnvelope = {
      signature_scope: composeMultisigDraft.policy.signature_scope,
      payload: JSON.parse(composeMultisigDraft.canonical_payload) as unknown,
      co_signatures: composeMultisigDraft.collected_signatures,
      multisig_policy: composeMultisigDraft.policy,
    };
    setDraftPayload(JSON.stringify(finalizedEnvelope, null, 2));
    setStatus('Multisig envelope finalized. Review payload below and submit with your standard flow.');
  };

  const handleResetComposeMultisigDraft = () => {
    setComposeMultisigDraft(null);
    setComposeDraftJson('');
    setComposeDraftSignerDid('');
    setComposeDraftSignerSignature('');
    setStatus('Multisig draft cleared.');
  };

  const handleDecryptWithReaderKey = async () => {
    setStatus('');
    setDecryptedPayload('');
    setDecryptedAttachment(null);
    if (!decryptAuthorPublicKeyHex.trim() || !decryptWrappedDekHex.trim() || !decryptNonceHex.trim() || !decryptCiphertextHex.trim()) {
      setStatus('Provide author public key, wrapped DEK, nonce, and ciphertext.');
      return;
    }
    const result = await callWallet('wallet_decryptOwnedTransactionCiphertext', [{
      authorPublicKeyHex: decryptAuthorPublicKeyHex,
      wrappedDekHex: decryptWrappedDekHex,
      nonceHex: decryptNonceHex,
      ciphertextHex: decryptCiphertextHex,
    }]);
    if (!result.ok || !result.result || typeof result.result !== 'object') {
      setStatus(result.error ?? 'Unable to decrypt ciphertext for this wallet.');
      return;
    }
    const payload = result.result as { plaintext?: string; plaintextJson?: unknown };
    const extractAttachment = (value: unknown): DecryptedAttachment | null => {
      if (!value || typeof value !== 'object') {
        return null;
      }
      const root = value as Record<string, unknown>;
      const source = root.payload && typeof root.payload === 'object'
        ? root.payload as Record<string, unknown>
        : root;
      const base64 = typeof source.attachmentBase64 === 'string' ? source.attachmentBase64.trim() : '';
      if (!base64) {
        return null;
      }
      const name = typeof source.attachmentName === 'string' && source.attachmentName.trim()
        ? source.attachmentName.trim()
        : 'attachment.bin';
      const mimeType = typeof source.attachmentMimeType === 'string' && source.attachmentMimeType.trim()
        ? source.attachmentMimeType.trim()
        : 'application/octet-stream';
      const sha256 = typeof source.attachmentSha256 === 'string' ? source.attachmentSha256.trim() : undefined;
      return {
        base64,
        name,
        mimeType,
        sha256,
      };
    };
    if (payload.plaintextJson) {
      setDecryptedPayload(JSON.stringify(payload.plaintextJson, null, 2));
      setDecryptedAttachment(extractAttachment(payload.plaintextJson));
    } else {
      setDecryptedPayload(payload.plaintext ?? '');
      try {
        const parsed = payload.plaintext ? JSON.parse(payload.plaintext) as unknown : null;
        setDecryptedAttachment(extractAttachment(parsed));
      } catch {
        setDecryptedAttachment(null);
      }
    }
    setStatus('Ciphertext decrypted with active wallet reader key.');
  };

  const handleDownloadDecryptedAttachment = () => {
    if (!decryptedAttachment) {
      setStatus('No attachment payload found in decrypted content.');
      return;
    }
    try {
      const raw = atob(decryptedAttachment.base64);
      const bytes = new Uint8Array(raw.length);
      for (let index = 0; index < raw.length; index += 1) {
        bytes[index] = raw.charCodeAt(index);
      }
      const blob = new Blob([bytes], { type: decryptedAttachment.mimeType });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = decryptedAttachment.name;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(href);
      setStatus(`Attachment downloaded${decryptedAttachment.sha256 ? ` (${decryptedAttachment.sha256})` : ''}.`);
    } catch (error) {
      setStatus(error instanceof Error ? `Unable to download attachment: ${error.message}` : 'Unable to download attachment.');
    }
  };

  const handlePrefillDecryptFromTransaction = () => {
    setStatus('');
    if (!decryptTransactionJson.trim()) {
      setStatus('Paste the transaction JSON first.');
      return;
    }
    try {
      const parsed = JSON.parse(decryptTransactionJson) as Record<string, unknown>;
      const payload = (parsed.payload && typeof parsed.payload === 'object')
        ? parsed.payload as Record<string, unknown>
        : {};
      const wrappedSecrets = Array.isArray(parsed.key_wrapped_secrets)
        ? parsed.key_wrapped_secrets as Array<Record<string, unknown>>
        : [];
      const activeReaderDid = protocolKeyMaterial?.reader.readerDid;
      const matchingWrap = wrappedSecrets.find((entry) => typeof entry.reader_id === 'string' && entry.reader_id === activeReaderDid)
        ?? wrappedSecrets.find((entry) => typeof entry.wrapped_dek === 'string');
      const authorPublicKeyHex = typeof payload.hybrid_author_x25519_public_key === 'string'
        ? payload.hybrid_author_x25519_public_key
        : typeof payload.author_public_key === 'string'
          ? payload.author_public_key
          : '';
      const wrappedDekHex = typeof matchingWrap?.wrapped_dek === 'string' ? matchingWrap.wrapped_dek : '';
      const nonceHex = typeof parsed.nonce_hex === 'string' ? parsed.nonce_hex : '';
      const ciphertextHex = typeof parsed.ciphertext_hex === 'string' ? parsed.ciphertext_hex : '';
      setDecryptAuthorPublicKeyHex(authorPublicKeyHex);
      setDecryptWrappedDekHex(wrappedDekHex);
      setDecryptNonceHex(nonceHex);
      setDecryptCiphertextHex(ciphertextHex);
      if (!authorPublicKeyHex || !wrappedDekHex || !nonceHex || !ciphertextHex) {
        setStatus('Loaded JSON, but some decrypt fields are missing. Confirm payload/key_wrapped_secrets fields.');
        return;
      }
      setStatus('Decrypt fields loaded from transaction JSON.');
    } catch (error) {
      setStatus(error instanceof Error ? `Invalid transaction JSON: ${error.message}` : 'Invalid transaction JSON.');
    }
  };

  const handleBuildGrantDraft = () => {
    const result = createMultisigGrantDraft({
      authorDid: state.account,
      creditGrantId: grantId,
      sponsorBuilderId: sponsorDid,
      sponsoredDid,
      sponsorshipId,
      sponsorUsageAmount,
      grantAmount,
      multisigThreshold,
      grantScope,
    });
    setDraftErrors(result.errors);
    setDraftPayload(result.payloadJson);
  };

  const handleBuildSponsorDraft = () => {
    const result = createSponsorUsageDraft({
      authorDid: state.account,
      creditGrantId: grantId,
      sponsorBuilderId: sponsorDid,
      sponsoredDid,
      sponsorshipId,
      sponsorUsageAmount,
      grantAmount,
      multisigThreshold,
      grantScope,
    });
    setDraftErrors(result.errors);
    setDraftPayload(result.payloadJson);
  };

  const applyPreset = (preset: keyof typeof SPONSORSHIP_PRESETS) => {
    const config = SPONSORSHIP_PRESETS[preset];
    setGrantScope(config.grantScope);
    setSponsoredDid(config.sponsoredDid);
    setSponsorshipId(config.sponsorshipId);
    setStatus(`Applied ${preset} sponsorship preset.`);
  };

  const saveProfile = async () => {
    await chrome.storage.local.set({ [PROFILE_KEY]: profile });
    setStatus('Profile details saved locally by user choice.');
  };

  const handleApproveDappRequest = async (requestId: string) => {
    const response = await callWallet('wallet_approveDappRequest', [requestId]);
    if (!response.ok && response.error?.includes('ERR_NETWORK_UNAVAILABLE')) {
      handleNetworkUnavailable(response.error);
      return;
    }
    setStatus(response.ok ? 'Request approved and ready for signing.' : response.error ?? 'Unable to approve request.');
    await refreshState();
  };

  const handleRejectDappRequest = async (requestId: string) => {
    const response = await callWallet('wallet_rejectDappRequest', [requestId]);
    setStatus(response.ok ? 'Request rejected.' : response.error ?? 'Unable to reject request.');
    await refreshState();
  };

  const handleCancelDappRequest = async (requestId: string) => {
    const response = await callWallet('wallet_cancelDappRequest', [requestId]);
    setStatus(response.ok ? 'Request cancelled and closed.' : response.error ?? 'Unable to cancel request.');
    await refreshState();
  };

  const handleSetOriginPermission = async (origin: string, permission: 'prompt' | 'blocked') => {
    const response = await callWallet('wallet_setOriginPermission', [origin, permission]);
    if (!response.ok) {
      setStatus(response.error ?? 'Unable to update origin permission.');
      return;
    }
    setStatus(permission === 'blocked' ? `Blocked ${origin}.` : `Restored ${origin} to prompt mode.`);
    await refreshState();
  };

  const blockedOrigins = useMemo(
    () => originPermissions.filter((entry) => entry.permission === 'blocked'),
    [originPermissions],
  );

  const handleDirectSubmitLatestSigned = async () => {
    if (!confirmDirectSubmitDestination) {
      setStatus('Confirm the destination endpoint before direct submit.');
      return;
    }
    const response = await callWallet('wallet_directSubmitLatestSignedArtifact', [
      directSubmitDestination,
      consentShareSigningPayload,
    ]);
    if (!response.ok) {
      if (response.error?.includes('ERR_NETWORK_UNAVAILABLE')) {
        handleNetworkUnavailable(response.error);
        return;
      }
      setStatus(response.error ?? 'Direct submit failed.');
      return;
    }
    setStatus('Direct submit accepted. Receipt metadata persisted locally.');
    setConfirmDirectSubmitDestination(false);
    setConsentShareSigningPayload(false);
    await refreshState();
  };

  const handleSetDefaultDirectSubmitDestination = async () => {
    const response = await callWallet('wallet_setDirectSubmitDefaultDestination', [directSubmitDestination]);
    if (!response.ok) {
      setStatus(response.error ?? 'Unable to update direct submit destination.');
      return;
    }
    setStatus('Default direct submit destination updated.');
    await refreshState();
  };

  const handleSelectLiveNetwork = async (network: NetworkId) => {
    await handleNetworkChange(network);
  };

  const handleCopySignerDid = async () => {
    const signerDid = protocolKeyMaterial?.signer.did;
    if (!signerDid || signerDid === 'Unavailable') {
      setStatus('Signer DID is unavailable to copy.');
      return;
    }
    await navigator.clipboard.writeText(signerDid);
    setStatus('Signer DID copied to clipboard.');
  };

  const handleCopyReaderDid = async () => {
    const readerDid = protocolKeyMaterial?.reader.readerDid;
    if (!readerDid || readerDid === 'Unavailable') {
      setStatus('Reader DID is unavailable to copy.');
      return;
    }
    await navigator.clipboard.writeText(readerDid);
    setStatus('Reader DID copied to clipboard.');
  };

  if (isLoading) {
    return (
      <main className="wallet-root">
        <section className="wallet-frame loading-state" aria-label="wallet loading">
          <img className="brand-logo loading-logo" src="/icons/icon128.png" alt="Citizen Wallet logo" />
          <h1>Citizen Wallet</h1>
          <p>Loading secure signer session…</p>
        </section>
      </main>
    );
  }

  if (!hasStoredWallet) {
    return (
      <main className="wallet-root">
        <section className="wallet-frame auth-state" aria-label="wallet onboarding">
          <div className="brand-row centered-brand">
            <img className="brand-logo" src="/icons/icon128.png" alt="Citizen Wallet logo" />
            <div>
              <p className="brand-kicker">Citizen Protocol</p>
              <h1>Welcome to Signer Wallet</h1>
            </div>
          </div>
          <article className="request-card">
            <h2>First-time setup</h2>
            <p className="meta-text">Import an existing wallet or create a new one to continue.</p>
            <div className="form-grid">
              {needsPasswordSetup ? (
                <input
                  type="password"
                  placeholder="Set wallet password"
                  value={passwordInput}
                  onChange={(event) => setPasswordInput(event.target.value)}
                />
              ) : null}
              <input
                type="text"
                placeholder="Derivation path"
                value={derivationPath}
                onChange={(event) => setDerivationPath(event.target.value)}
              />
              <input
                type="text"
                placeholder="Import seed phrase"
                value={importMnemonicPhrase}
                onChange={(event) => setImportMnemonicPhrase(event.target.value)}
              />
              <select
                value={mnemonicWordCount}
                onChange={(event) => setMnemonicWordCount(Number(event.target.value) as MnemonicWordCount)}
              >
                <option value={12}>12-word seed</option>
                <option value={24}>24-word seed</option>
              </select>
              <button className="ghost" onClick={handleImportMnemonic}>Import existing wallet</button>
              <button className="primary" onClick={handleGenerateMnemonicWallet}>Create new wallet</button>
              {status ? <p>{status}</p> : null}
            </div>
          </article>
        </section>
      </main>
    );
  }

  if (locked || needsPasswordSetup) {
    return (
      <main className="wallet-root">
        <section className="wallet-frame auth-state" aria-label="wallet unlock">
          <div className="brand-row centered-brand">
            <img className="brand-logo" src="/icons/icon128.png" alt="Citizen Wallet logo" />
            <div>
              <p className="brand-kicker">Citizen Protocol</p>
              <h1>{needsPasswordSetup ? 'Set wallet password' : 'Unlock wallet'}</h1>
            </div>
          </div>
          <article className="request-card">
            <h2>{needsPasswordSetup ? 'Protect this wallet' : 'Session locked'}</h2>
            <p className="meta-text">
              {needsPasswordSetup
                ? 'Set your password to protect wallet access.'
                : 'Enter your password to continue.'}
            </p>
            <div className="form-grid">
              <input
                type="password"
                placeholder={needsPasswordSetup ? 'Set wallet password' : 'Enter wallet password'}
                value={passwordInput}
                onChange={(event) => setPasswordInput(event.target.value)}
              />
              <button className="primary" onClick={handlePasswordSubmit}>
                {needsPasswordSetup ? 'Set password & unlock' : 'Unlock wallet'}
              </button>
              {status ? <p>{status}</p> : null}
            </div>
          </article>
        </section>
      </main>
    );
  }

  return (
    <main className="wallet-root">
      <section className="wallet-frame" aria-label="browser wallet status">
        <header className="wallet-header">
          <div className="top-nav">
            <div className="brand-row no-margin">
              <img className="brand-logo" src="/icons/icon128.png" alt="Citizen Wallet logo" />
              <div>
                <p className="brand-kicker">Citizen Protocol</p>
                <h1>Signer Wallet</h1>
              </div>
            </div>
            <button className="menu-button" onClick={() => setMenuOpen((current) => !current)} aria-label="Toggle menu">
              ☰
            </button>
          </div>
          <div className="header-controls">
            <label htmlFor="network" className="network-label">Network</label>
            <select
              id="network"
              value={state.network}
              onChange={(event) => void handleNetworkChange(event.target.value as NetworkId)}
            >
              {NETWORK_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </div>
          <p className="network-pill">citizen-{state.network}</p>
          {protocolKeyMaterial ? (
            <div className="top-address-row">
              <p className="top-address" title={protocolKeyMaterial.signer.did}>
                Signer (Ed25519): {mask(protocolKeyMaterial.signer.did)}
              </p>
              <button
                className="copy-address-button"
                onClick={() => void handleCopySignerDid()}
                aria-label="Copy signer DID to clipboard"
                title="Copy signer DID"
              >
                📋
              </button>
            </div>
          ) : null}
          {protocolKeyMaterial ? (
            <div className="top-address-row">
              <p className="top-address" title={protocolKeyMaterial.reader.readerDid}>
                Reader (X25519): {mask(protocolKeyMaterial.reader.readerDid)}
              </p>
              <button
                className="copy-address-button"
                onClick={() => void handleCopyReaderDid()}
                aria-label="Copy reader DID to clipboard"
                title="Copy reader DID"
              >
                📋
              </button>
            </div>
          ) : null}
        </header>
        {menuOpen ? (
          <nav className="menu-panel" aria-label="Wallet menu">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                className={item.id === activeTab ? 'primary' : 'ghost'}
                onClick={() => {
                  setActiveTab(item.id);
                  setMenuOpen(false);
                }}
              >
                {item.label}
              </button>
            ))}
            <button className="ghost menu-action" onClick={() => void handleLock()}>
              Logout
            </button>
          </nav>
        ) : null}
        {!selectedNetworkIsLive ? (
          <div className="network-modal-backdrop" role="presentation">
            <article className="network-modal" role="dialog" aria-modal="true" aria-label="Switch to live network">
              <h2>Network unavailable</h2>
              <p className="meta-text">
                The currently selected network is offline. Choose a live network below to continue.
              </p>
              <div className="form-grid">
                {modalNetworkOptions.length > 0 ? (
                  modalNetworkOptions.map((option) => (
                    <button
                      key={option.id}
                      className={networkLiveness[option.id] ? 'primary' : 'ghost'}
                      disabled={!networkLiveness[option.id]}
                      onClick={() => void handleSelectLiveNetwork(option.id)}
                    >
                      {networkLiveness[option.id]
                        ? `Switch to ${option.label}`
                        : `${option.label} (offline)`}
                    </button>
                  ))
                ) : (
                  <p className="meta-text">No active network is reachable right now.</p>
                )}
              </div>
            </article>
          </div>
        ) : null}

        <div className="wallet-scroll">
          {activeTab === 'activity' ? (
            <>
              {!approvalUiEnabled && pendingRequests.length > 0 ? (
                <article className="request-card">
                  <h2>Notifications</h2>
                  <p className="meta-text">
                    Dedicated dApp approval UI is currently disabled for this rollout stage ({rolloutLabel(APPROVAL_UI_ROLLOUT_STAGE)}).
                    Pending requests will expire automatically unless this stage is enabled.
                  </p>
                </article>
              ) : null}

              {approvalUiEnabled && pendingRequests.length > 0 ? (
                <article className="request-card">
                  <h2>Notifications</h2>
                  <p className="meta-text">
                    You have {pendingRequests.length} dApp signing request{pendingRequests.length === 1 ? '' : 's'} pending review.
                  </p>
                  {pendingRequests.map((entry) => (
                    <div key={entry.requestId} className="pending-request">
                      <p className="meta-text">🔒 Origin lock active. Verify the full URL before signing.</p>
                      <dl>
                        <div>
                          <dt>Origin</dt>
                          <dd>{entry.origin.origin}</dd>
                        </div>
                        <div>
                          <dt>URL</dt>
                          <dd>{showFullUrlByRequest[entry.requestId] ? (entry.origin.tabUrl ?? 'Unavailable') : mask(entry.origin.tabUrl ?? 'Unavailable')}</dd>
                        </div>
                        <div>
                          <dt>Method</dt>
                          <dd>{entry.method}</dd>
                        </div>
                        <div>
                          <dt>Requested</dt>
                          <dd>{new Date(entry.createdAt).toLocaleString()}</dd>
                        </div>
                        <div>
                          <dt>Expires</dt>
                          <dd>{new Date(entry.expiresAt).toLocaleString()}</dd>
                        </div>
                        <div>
                          <dt>Payload hash</dt>
                          <dd>{mask(entry.payload.hash)}</dd>
                        </div>
                        <div>
                          <dt>Risk flags</dt>
                          <dd>{entry.riskFlags.length > 0 ? entry.riskFlags.join(', ') : 'none'}</dd>
                        </div>
                        <div>
                          <dt>Policy checks</dt>
                          <dd>
                            {entry.policyChecks.length > 0
                              ? entry.policyChecks.map((check) => check.message).join(' | ')
                              : 'pass'}
                          </dd>
                        </div>
                      </dl>
                      <p className="meta-text">
                        What will be shared: only the canonical payload hash and signature are returned to this dApp.
                      </p>
                      <div className="button-row">
                        <button className="primary" onClick={() => handleApproveDappRequest(entry.requestId)}>
                          Approve and sign
                        </button>
                        <button className="ghost" onClick={() => handleRejectDappRequest(entry.requestId)}>
                          Reject
                        </button>
                        <button className="ghost" onClick={() => handleCancelDappRequest(entry.requestId)}>
                          Cancel / close
                        </button>
                        <button
                          className="ghost"
                          onClick={() => void handleSetOriginPermission(entry.origin.origin, 'blocked')}
                        >
                          Block this origin
                        </button>
                        <button
                          className="ghost"
                          onClick={() => setShowFullUrlByRequest((current) => ({ ...current, [entry.requestId]: !current[entry.requestId] }))}
                        >
                          {showFullUrlByRequest[entry.requestId] ? 'Hide full URL' : 'Reveal full URL'}
                        </button>
                        <button
                          className="ghost"
                          onClick={() => setShowRawPayloadByRequest((current) => ({ ...current, [entry.requestId]: !current[entry.requestId] }))}
                        >
                          {showRawPayloadByRequest[entry.requestId] ? 'Hide raw payload' : 'Show raw payload'}
                        </button>
                      </div>
                      <h3>Payload preview</h3>
                      <dl>
                        {renderPayloadSummary(entry.payload.canonicalJson).map((section) => (
                          <div key={`${entry.requestId}-${section.label}`}>
                            <dt>{section.label}</dt>
                            <dd>{section.value}</dd>
                          </div>
                        ))}
                      </dl>
                      {showRawPayloadByRequest[entry.requestId] ? <pre className="raw-payload">{entry.payload.canonicalJson}</pre> : null}
                    </div>
                  ))}
                </article>
              ) : null}

              <article className="request-card">
                <h2>Signed transaction activity</h2>
                <p className="meta-text">
                  Signed requests for {activeWallet?.name ?? 'active wallet'} on {NETWORK_OPTIONS.find((network) => network.id === state.network)?.label ?? state.network}: {visibleSignedRequests.length}
                </p>
                {visibleSignedRequests.length > 0 ? (
                  <div className="signed-selection-list">
                    <ul>
                      {visibleSignedRequests.map((entry) => {
                        const receipt = latestReceiptByRequestId.get(entry.requestId)
                          ?? latestReceiptByPayloadHash.get(entry.payload.hash);
                        const committedHash = receipt?.receiptHash ?? null;
                        const explorerHashHref = committedHash
                          ? buildExplorerDataHashSearchHref(state.network, committedHash)
                          : null;
                        return (
                          <li key={entry.requestId} className="activity-item">
                            <div>
                              {explorerHashHref ? (
                                <a href={explorerHashHref} target="_blank" rel="noreferrer">
                                  <strong>{mask(committedHash ?? '')}</strong>
                                </a>
                              ) : (
                                <strong>{mask(entry.payload.hash)}</strong>
                              )}
                              <p className="meta-text">{new Date(entry.createdAt).toLocaleString()}</p>
                              <p className="meta-text">{entry.origin.origin}</p>
                              <p className="meta-text">
                                Status: {receipt ? 'success' : 'waiting for builder submission confirmation'}
                              </p>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : (
                  <p className="meta-text">No signed requests yet.</p>
                )}
                {visibleDirectSubmitReceipts.length > 0 ? (
                  <>
                    <h3>Commitment receipt hash lookups</h3>
                    <p className="meta-text">
                      Open matching blocks in Citizen Explorer using the hashed commitment receipt.
                    </p>
                    <ul>
                      {visibleDirectSubmitReceipts.map((receipt) => {
                        const receiptHash = receipt.receiptHash;
                        const explorerHref = receiptHash
                          ? buildExplorerDataHashSearchHref(state.network, receiptHash)
                          : null;
                        return (
                          <li key={`${receipt.traceId}-${receipt.submittedAt}`} className="activity-item">
                            <div>
                              <strong>{receipt.receiptId ?? mask(receipt.requestId)}</strong>
                              <p className="meta-text">{new Date(receipt.submittedAt).toLocaleString()}</p>
                              {explorerHref ? (
                                <a href={explorerHref} target="_blank" rel="noreferrer" className="meta-text">
                                  {mask(receiptHash ?? '')}
                                </a>
                              ) : (
                                <p className="meta-text">Pending hash</p>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                ) : null}
                {activity.length > 0 ? (
                  <ul>
                    {activity.map((entry) => (
                      <li key={`${entry.requestedAt}-${entry.method}`} className="activity-item">
                        <div>
                          <strong>{entry.method}</strong>
                          <p className="meta-text">{entry.origin}</p>
                        </div>
                        <span>{new Date(entry.requestedAt).toLocaleString()}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="meta-text">No signed activity yet.</p>
                )}
              </article>
            </>
          ) : null}

          {activeTab === 'compose' ? (
            <>
              <article className="request-card">
                <h2>Compose and sign transaction</h2>
                <p className="meta-text">Create a transaction payload and sign it with the active wallet account.</p>
                <div className="form-grid">
                  <textarea
                    rows={4}
                    value={composeMessage}
                    onChange={(event) => setComposeMessage(event.target.value)}
                    aria-label="Composed transaction payload"
                    disabled={Boolean(composeMultisigDraft)}
                  />
                  {composeMultisigDraft ? (
                    <p className="meta-text">
                      Multisig draft is active: canonical payload is locked until you clear/reset the draft.
                    </p>
                  ) : null}
                  <button className="primary" onClick={handleSignComposed}>Sign payload</button>
                  {composeSignature ? <code className="secret-box">{composeSignature}</code> : null}
                </div>
              </article>

              <article className="request-card">
                <h2>Multisigner compose draft</h2>
                <p className="meta-text">
                  Create/import <code>citizen.compose.multisig-draft.v1</code>, collect signer signatures, and finalize only when threshold is satisfied.
                </p>
                <div className="form-grid">
                  <input
                    value={composeAllowedSigners}
                    onChange={(event) => setComposeAllowedSigners(event.target.value)}
                    placeholder="allowed_signers (comma-separated DIDs)"
                  />
                  <div className="hero-actions">
                    <button className="primary" onClick={() => void handleInitComposeMultisigDraft()}>
                      Initialize draft
                    </button>
                    <button className="ghost" onClick={handleResetComposeMultisigDraft}>
                      Clear draft
                    </button>
                  </div>
                  <textarea
                    rows={8}
                    value={composeDraftJson}
                    onChange={(event) => setComposeDraftJson(event.target.value)}
                    aria-label="Compose multisig draft JSON"
                    placeholder="Paste draft JSON to import or edit before import."
                  />
                  <div className="hero-actions">
                    <button className="ghost" onClick={() => void handleImportComposeMultisigDraft()}>
                      Import draft
                    </button>
                    <button
                      className="ghost"
                      onClick={async () => {
                        await navigator.clipboard.writeText(composeDraftJson);
                        setStatus('Multisig draft copied to clipboard for signer handoff.');
                      }}
                      disabled={!composeDraftJson}
                    >
                      Copy draft for handoff
                    </button>
                  </div>
                  {composeMultisigDraft ? (
                    <>
                      <p className="meta-text">
                        Threshold progress: {composeCollectedSignerCount} / {composeMultisigDraft.policy.threshold}
                      </p>
                      <progress
                        max={composeMultisigDraft.policy.threshold}
                        value={Math.min(composeCollectedSignerCount, composeMultisigDraft.policy.threshold)}
                      />
                      <ul>
                        {composeMultisigDraft.collected_signatures.map((entry) => (
                          <li key={entry.signer}>
                            <strong>{entry.signer}</strong> — {mask(entry.signature)}
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  <input
                    value={composeDraftSignerDid}
                    onChange={(event) => setComposeDraftSignerDid(event.target.value)}
                    placeholder="co-signer DID"
                  />
                  <textarea
                    rows={3}
                    value={composeDraftSignerSignature}
                    onChange={(event) => setComposeDraftSignerSignature(event.target.value)}
                    placeholder="signature over canonical_payload"
                  />
                  <div className="hero-actions">
                    <button className="ghost" onClick={() => void handleAppendComposeDraftSignature()}>
                      Append signature
                    </button>
                    <button
                      className="primary"
                      onClick={handleFinalizeComposeMultisigDraft}
                      disabled={!composeThresholdSatisfied || !composeMultisigDraft}
                    >
                      Finalize multisig envelope (threshold required)
                    </button>
                  </div>
                </div>
              </article>

              <article className="request-card">
                <h2>Sponsorship draft builder</h2>
                <div className="form-grid">
                  <div className="hero-actions">
                    <button className="ghost" onClick={() => applyPreset('article')}>Use article preset</button>
                    <button className="ghost" onClick={() => applyPreset('governance')}>Use governance preset</button>
                  </div>
                  <input value={grantId} onChange={(event) => setGrantId(event.target.value)} placeholder="credit_grant_id" />
                  <input value={sponsorDid} onChange={(event) => setSponsorDid(event.target.value)} placeholder="sponsor_builder_id" />
                  <input value={sponsoredDid} onChange={(event) => setSponsoredDid(event.target.value)} placeholder="sponsored_did" />
                  <input value={sponsorshipId} onChange={(event) => setSponsorshipId(event.target.value)} placeholder="sponsorship_id" />
                  <input value={sponsorUsageAmount} onChange={(event) => setSponsorUsageAmount(event.target.value)} placeholder="amount (sponsor usage)" />
                  <input value={grantAmount} onChange={(event) => setGrantAmount(event.target.value)} placeholder="amount (credit grant)" />
                  <input value={multisigThreshold} onChange={(event) => setMultisigThreshold(event.target.value)} placeholder="multisig_threshold" />
                  <input value={grantScope} onChange={(event) => setGrantScope(event.target.value)} placeholder="grant_scope" />
                  <div className="hero-actions">
                    <button className="primary" onClick={handleBuildSponsorDraft}>Build sponsor usage draft</button>
                    <button className="ghost" onClick={handleBuildGrantDraft}>Build multisig grant draft</button>
                  </div>
                  <ul>
                    {checklist.map((item) => (
                      <li key={item.label}>{item.valid ? '✅' : '⚠️'} {item.label}</li>
                    ))}
                  </ul>
                  {draftErrors.length > 0 ? <p>{draftErrors.join(' ')}</p> : null}
                  {draftPayload ? <textarea readOnly value={draftPayload} rows={10} aria-label="Sponsor draft payload" /> : null}
                </div>
              </article>
            </>
          ) : null}

          {activeTab === 'decrypt' ? (
            <article className="request-card">
              <h2>Decrypt transaction ciphertext</h2>
              <p className="meta-text">
                Decrypt a hybrid encrypted transaction payload using the active wallet reader key.
              </p>
              <div className="form-grid">
                <textarea
                  rows={6}
                  value={decryptTransactionJson}
                  onChange={(event) => setDecryptTransactionJson(event.target.value)}
                  placeholder="Paste full transaction JSON (optional prefill)"
                />
                <button className="ghost" onClick={handlePrefillDecryptFromTransaction}>
                  Load fields from JSON
                </button>
                <input
                  type="text"
                  value={decryptAuthorPublicKeyHex}
                  onChange={(event) => setDecryptAuthorPublicKeyHex(event.target.value)}
                  placeholder="authorPublicKeyHex (32-byte hex)"
                />
                <input
                  type="text"
                  value={decryptWrappedDekHex}
                  onChange={(event) => setDecryptWrappedDekHex(event.target.value)}
                  placeholder="wrappedDekHex (nonce+ciphertext hex)"
                />
                <input
                  type="text"
                  value={decryptNonceHex}
                  onChange={(event) => setDecryptNonceHex(event.target.value)}
                  placeholder="nonceHex (24-byte XChaCha nonce)"
                />
                <textarea
                  rows={5}
                  value={decryptCiphertextHex}
                  onChange={(event) => setDecryptCiphertextHex(event.target.value)}
                  placeholder="ciphertextHex"
                />
                <button className="primary" onClick={handleDecryptWithReaderKey}>Decrypt</button>
                {decryptedAttachment ? (
                  <button className="ghost" onClick={handleDownloadDecryptedAttachment}>
                    Download decrypted attachment ({decryptedAttachment.name})
                  </button>
                ) : null}
                {decryptedPayload ? (
                  <textarea readOnly rows={8} value={decryptedPayload} aria-label="Decrypted payload" />
                ) : null}
              </div>
            </article>
          ) : null}

          {activeTab === 'vault' ? (
            <article className="request-card">
              <h2>Vault (wallet list)</h2>
              <p className="meta-text">Add wallets, choose the default active wallet, and switch instantly.</p>
              <div className="form-grid">
                <input
                  type="text"
                  placeholder="Derivation path"
                  value={derivationPath}
                  onChange={(event) => setDerivationPath(event.target.value)}
                />
                <input
                  type="text"
                  placeholder="Import seed phrase"
                  value={importMnemonicPhrase}
                  onChange={(event) => setImportMnemonicPhrase(event.target.value)}
                />
                <select
                  value={mnemonicWordCount}
                  onChange={(event) => setMnemonicWordCount(Number(event.target.value) as MnemonicWordCount)}
                >
                  <option value={12}>12-word seed</option>
                  <option value={24}>24-word seed</option>
                </select>
                <button className="ghost" onClick={handleImportMnemonic}>Add wallet from seed phrase</button>
                <button className="primary" onClick={handleGenerateMnemonicWallet}>Generate new wallet + seed</button>
                {vaultWallets.map((wallet) => (
                  <div key={wallet.id} className="vault-row">
                    <div>
                      <strong>{wallet.name}</strong>
                      <p className="meta-text">{mask(wallet.signerDid)}</p>
                      {wallet.mnemonicWordCount ? (
                        <p className="meta-text">Seed: {wallet.mnemonicWordCount} words</p>
                      ) : null}
                    </div>
                    <button
                      className={wallet.isActive ? 'primary' : 'ghost'}
                      onClick={() => void handleSetActiveWallet(wallet.id)}
                    >
                      {wallet.isActive ? 'Active' : 'Use wallet'}
                    </button>
                  </div>
                ))}
              </div>
            </article>
          ) : null}

          {activeTab === 'security' ? (
            <>
              <article className="request-card">
                <h2>Security</h2>
                <div className="form-grid">
                  <input
                    type="password"
                    placeholder={needsPasswordSetup ? 'Set wallet password' : 'Enter wallet password'}
                    value={passwordInput}
                    onChange={(event) => setPasswordInput(event.target.value)}
                  />
                  <button className="primary" onClick={handlePasswordSubmit}>
                    {needsPasswordSetup ? 'Set password & unlock' : 'Unlock wallet'}
                  </button>
                  <button className="ghost" onClick={handleLock}>Lock wallet</button>
                </div>
              </article>

              <article className="request-card">
                <h2>Protocol wallet credentials (Ed25519 + X25519) (reveal/hide)</h2>
                <div className="form-grid">
                  <input
                    type="password"
                    placeholder="Re-enter password to reveal wallet protocol credentials"
                    value={secretPassword}
                    onChange={(event) => setSecretPassword(event.target.value)}
                  />
                  <button className="primary" onClick={handleRevealSecret}>Reveal wallet protocol credentials</button>
                  {protocolKeypairs ? <button className="ghost" onClick={() => { setProtocolKeypairs(null); }}>Hide credentials</button> : null}
                  {protocolKeypairs ? <button className="ghost" onClick={handleCopySecret}>Copy credentials</button> : null}
                  {protocolKeypairs ? (
                    <code className="secret-box">{JSON.stringify(protocolKeypairs, null, 2)}</code>
                  ) : (
                    <p className="meta-text">Hidden</p>
                  )}
                </div>
              </article>

              <article className="request-card">
                <h2>Seed phrase (reveal/hide)</h2>
                <div className="form-grid">
                  <input
                    type="password"
                    placeholder="Re-enter password to reveal seed phrase"
                    value={mnemonicPassword}
                    onChange={(event) => setMnemonicPassword(event.target.value)}
                  />
                  <button className="primary" onClick={handleRevealMnemonic}>Reveal seed phrase</button>
                  {mnemonicPhrase ? <button className="ghost" onClick={() => setMnemonicPhrase('')}>Hide seed phrase</button> : null}
                  {mnemonicPhrase ? <code className="secret-box">{mnemonicPhrase}</code> : <p className="meta-text">Hidden</p>}
                </div>
              </article>

              <article className="request-card">
                <h2>dApp origin permissions</h2>
                <p className="meta-text">Blocked origins cannot submit new signing requests until you revoke the block.</p>
                {blockedOrigins.length > 0 ? (
                  <ul>
                    {blockedOrigins.map((entry) => (
                      <li key={entry.origin} className="activity-item">
                        <div>
                          <strong>{entry.origin}</strong>
                          <p className="meta-text">Blocked on {new Date(entry.updatedAt).toLocaleString()}</p>
                        </div>
                        <button
                          className="ghost"
                          onClick={() => void handleSetOriginPermission(entry.origin, 'prompt')}
                        >
                          Revoke block
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="meta-text">No blocked origins.</p>
                )}
              </article>
            </>
          ) : null}

          {activeTab === 'profile' ? (
            <article className="request-card">
              <h2>Profile settings</h2>
              <p className="meta-text">User-controlled details for optional KYC-oriented flows.</p>
              <div className="form-grid">
                <input value={profile.fullName} onChange={(event) => setProfile((current) => ({ ...current, fullName: event.target.value }))} placeholder="Full name" />
                <input value={profile.email} onChange={(event) => setProfile((current) => ({ ...current, email: event.target.value }))} placeholder="Email address" />
                <input value={profile.address} onChange={(event) => setProfile((current) => ({ ...current, address: event.target.value }))} placeholder="Address" />
                <input value={profile.profession} onChange={(event) => setProfile((current) => ({ ...current, profession: event.target.value }))} placeholder="Profession" />
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={profile.kycVerified}
                    onChange={(event) => setProfile((current) => ({ ...current, kycVerified: event.target.checked }))}
                  />
                  <span>Verify KYC</span>
                </label>
                <button className="primary" onClick={saveProfile}>Save profile</button>
              </div>
            </article>
          ) : null}

          {state.lastRequest ? (
            <article className="request-card">
              <h2>Last dApp request</h2>
              <dl>
                <div>
                  <dt>Origin</dt>
                  <dd>{state.lastRequest.origin}</dd>
                </div>
                <div>
                  <dt>Method</dt>
                  <dd>{state.lastRequest.method}</dd>
                </div>
                <div>
                  <dt>Time</dt>
                  <dd>{new Date(state.lastRequest.requestedAt).toLocaleString()}</dd>
                </div>
              </dl>
            </article>
          ) : null}
          {status ? <p className="status-line">{status}</p> : null}
        </div>
      </section>
    </main>
  );
}
