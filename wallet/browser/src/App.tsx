import { useEffect, useMemo, useState } from 'react';
import {
  buildStrictBuilderCreditChecklist,
  createMultisigGrantDraft,
  createSponsorUsageDraft,
} from './builderCreditDraft';

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
  address: string;
  hasMnemonic: boolean;
  createdAt: string;
  isActive: boolean;
};

type ProfileDetails = {
  fullName: string;
  email: string;
  address: string;
  profession: string;
  kycVerified: boolean;
};

type TabId = 'activity' | 'compose' | 'vault' | 'security' | 'profile';

type NetworkId = 'mainnet' | 'futurenet' | 'testnet' | 'localnode';

const NETWORK_OPTIONS: { id: NetworkId; label: string }[] = [
  { id: 'mainnet', label: 'Mainnet' },
  { id: 'futurenet', label: 'Futurenet' },
  { id: 'testnet', label: 'Testnet' },
  { id: 'localnode', label: 'Local Node' },
];

const NAV_ITEMS: { id: TabId; label: string }[] = [
  { id: 'activity', label: 'Activity' },
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

async function callWallet(method: string, params?: unknown[]): Promise<WalletResponse> {
  return chrome.runtime.sendMessage({ method, params }) as Promise<WalletResponse>;
}

export function App() {
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>('activity');
  const [menuOpen, setMenuOpen] = useState(false);
  const [hasStoredWallet, setHasStoredWallet] = useState(false);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [vaultWallets, setVaultWallets] = useState<VaultWallet[]>([]);
  const [profile, setProfile] = useState<ProfileDetails>({
    fullName: '',
    email: '',
    address: '',
    profession: '',
    kycVerified: false,
  });
  const [composeMessage, setComposeMessage] = useState('Authorize Citizen transaction payload v1');
  const [composeSignature, setComposeSignature] = useState('');
  const [state, setState] = useState<WalletState>({
    account: 'Not initialized',
    network: 'mainnet',
    lastRequest: null,
  });
  const [passwordInput, setPasswordInput] = useState('');
  const [needsPasswordSetup, setNeedsPasswordSetup] = useState(false);
  const [locked, setLocked] = useState(false);
  const [status, setStatus] = useState('');
  const [secretPassword, setSecretPassword] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [mnemonicPassword, setMnemonicPassword] = useState('');
  const [mnemonicPhrase, setMnemonicPhrase] = useState('');
  const [importMnemonicPhrase, setImportMnemonicPhrase] = useState('');
  const [derivationPath, setDerivationPath] = useState("m/44'/930'/0'/0'/0'");
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

  const checklist = useMemo(
    () =>
      buildStrictBuilderCreditChecklist({
        authorDid: state.account,
        creditGrantId: grantId,
        sponsorBuilderId: sponsorDid,
        sponsoredDid,
        sponsorshipId,
        sponsorUsageAmount,
        grantAmount,
        multisigThreshold,
        grantScope,
      }),
    [grantAmount, grantId, grantScope, multisigThreshold, sponsorDid, sponsorUsageAmount, sponsoredDid, sponsorshipId, state.account],
  );

  const refreshState = async () => {
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
        setVaultWallets(vaultResponse.result as VaultWallet[]);
      }

      if (!hasWallet || !isUnlocked) {
        setState({
          account: hasWallet ? (isUnlocked ? 'Ready' : 'Locked') : 'Wallet not configured',
          network,
          lastRequest: lastRequest ?? null,
        });
        if (!isUnlocked) {
          setSecretKey('');
          setComposeSignature('');
        }
        return;
      }

      const accountResponse = (await callWallet('citizen_accounts')) as { ok: boolean; result?: string[] };
      const account = accountResponse.ok ? accountResponse.result?.[0] ?? 'Unavailable' : 'Unavailable';
      setState({ account, network, lastRequest: lastRequest ?? null });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void refreshState();
  }, []);

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
    setSecretKey('');
    setSecretPassword('');
    await refreshState();
  };

  const handleRevealSecret = async () => {
    setStatus('');
    if (!secretPassword) {
      setStatus('Enter password to view secret key.');
      return;
    }

    const result = await callWallet('wallet_exportPrivateKey', [secretPassword]);
    if (!result.ok || typeof result.result !== 'string') {
      setStatus(result.error ?? 'Unable to reveal secret key.');
      return;
    }

    setSecretKey(result.result);
    setSecretPassword('');
    setStatus('Secret key revealed. Keep it private and rotate if exposed.');
  };

  const handleCopySecret = async () => {
    if (!secretKey) {
      return;
    }
    await navigator.clipboard.writeText(secretKey);
    setStatus('Secret key copied to clipboard.');
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
    setStatus('Seed phrase imported. Wallet account updated.');
    await refreshState();
  };

  const handleGenerateMnemonicWallet = async () => {
    setStatus('');
    if (!(await ensurePasswordSetupIfNeeded())) {
      return;
    }
    const result = await callWallet('wallet_generateMnemonicWallet', [derivationPath]);
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
    const result = await callWallet('personal_sign', [composeMessage, state.account]);
    if (!result.ok || typeof result.result !== 'string') {
      setStatus(result.error ?? 'Unable to sign composed transaction payload.');
      return;
    }
    setComposeSignature(result.result);
    setStatus('Composed payload signed successfully.');
    await refreshState();
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
          {menuOpen ? (
            <nav className="menu-panel">
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
            </nav>
          ) : null}
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
          <p className="top-address" title={state.account}>Wallet: {mask(state.account)}</p>
        </header>

        <div className="wallet-scroll">
          {activeTab === 'activity' ? (
            <>
              <article className="request-card">
                <h2>Create transaction</h2>
                <p className="meta-text">Quick CTA to start composing and signing a new transaction payload.</p>
                <button className="primary" onClick={() => setActiveTab('compose')}>Open Compose tab</button>
              </article>

              <article className="request-card">
                <h2>Signed transaction activity</h2>
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
                  />
                  <button className="primary" onClick={handleSignComposed}>Sign payload</button>
                  {composeSignature ? <code className="secret-box">{composeSignature}</code> : null}
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
                <button className="ghost" onClick={handleImportMnemonic}>Add wallet from seed phrase</button>
                <button className="primary" onClick={handleGenerateMnemonicWallet}>Generate new wallet + seed</button>
                {vaultWallets.map((wallet) => (
                  <div key={wallet.id} className="vault-row">
                    <div>
                      <strong>{wallet.name}</strong>
                      <p className="meta-text">{mask(wallet.address)}</p>
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
                <h2>Secret key (reveal/hide)</h2>
                <div className="form-grid">
                  <input
                    type="password"
                    placeholder="Re-enter password to reveal secret key"
                    value={secretPassword}
                    onChange={(event) => setSecretPassword(event.target.value)}
                  />
                  <button className="primary" onClick={handleRevealSecret}>Reveal secret key</button>
                  {secretKey ? <button className="ghost" onClick={() => setSecretKey('')}>Hide secret key</button> : null}
                  {secretKey ? <button className="ghost" onClick={handleCopySecret}>Copy secret key</button> : null}
                  {secretKey ? <code className="secret-box">{secretKey}</code> : <p className="meta-text">Hidden</p>}
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
