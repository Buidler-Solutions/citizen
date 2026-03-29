import { useEffect, useState } from 'react';
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

type NetworkId = 'mainnet' | 'futurenet' | 'testnet' | 'localnode';

const NETWORK_OPTIONS: { id: NetworkId; label: string }[] = [
  { id: 'mainnet', label: 'Mainnet' },
  { id: 'futurenet', label: 'Futurenet' },
  { id: 'testnet', label: 'Testnet' },
  { id: 'localnode', label: 'Local Node' },
];

type WalletResponse = {
  ok: boolean;
  result?: unknown;
  error?: string;
};

const STORAGE_KEY = 'citizen.browser.wallet.v1';
const LAST_REQUEST_KEY = 'citizen.browser.wallet.last_request.v1';

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
  const checklist = buildStrictBuilderCreditChecklist({
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

  const refreshState = async () => {
    const stored = await chrome.storage.local.get([STORAGE_KEY, LAST_REQUEST_KEY]);
    const wallet = stored[STORAGE_KEY] as { privateKey?: string } | undefined;
    const lastRequest = stored[LAST_REQUEST_KEY] as WalletState['lastRequest'];

    const passwordSet = await callWallet('wallet_isPasswordSet');
    setNeedsPasswordSetup(passwordSet.ok ? !(passwordSet.result as boolean) : true);

    const unlocked = await callWallet('wallet_isUnlocked');
    const isUnlocked = unlocked.ok ? (unlocked.result as boolean) : false;
    setLocked(!isUnlocked);

    const selectedNetwork = await callWallet('wallet_getNetwork');
    const network = selectedNetwork.ok
      ? (selectedNetwork.result as NetworkId)
      : 'mainnet';

    if (!wallet?.privateKey || !isUnlocked) {
      setState({
        account: isUnlocked ? 'Wallet will initialize on first request' : 'Locked',
        network,
        lastRequest: lastRequest ?? null,
      });
      if (!isUnlocked) {
        setSecretKey('');
      }
      return;
    }

    const accountResponse = (await callWallet('citizen_accounts')) as { ok: boolean; result?: string[] };
    const account = accountResponse.ok ? accountResponse.result?.[0] ?? 'Unavailable' : 'Unavailable';
    setState({ account, network, lastRequest: lastRequest ?? null });
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

  return (
    <main className="wallet-root">
      <section className="wallet-frame" aria-label="browser wallet status">
        <header className="wallet-header">
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
          <p className="top-address" title={state.account}>Wallet: {state.account}</p>
          <h1>Citizen Signer Wallet</h1>
          <p>Password lock is required before account access and signing.</p>
          <p className="security-note">Seed phrase flow now supports CLI-style derivation path defaults.</p>
        </header>

        <div className="wallet-scroll">
          <article className="request-card">
            <h2>Security</h2>
            <dl>
              <div>
                <dt>Password</dt>
                <dd>{needsPasswordSetup ? 'Not set' : 'Configured'}</dd>
              </div>
              <div>
                <dt>Wallet state</dt>
                <dd>{locked ? 'Locked' : 'Unlocked'}</dd>
              </div>
            </dl>
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
              {!locked && !needsPasswordSetup ? (
                <button className="ghost" onClick={handleLock}>Lock wallet</button>
              ) : null}
              {status ? <p>{status}</p> : null}
            </div>
          </article>

          <article className="request-card">
            <h2>Secret key (secure reveal)</h2>
            <p className="meta-text">Requires unlocked wallet + password confirmation.</p>
            <div className="form-grid">
              <input
                type="password"
                placeholder="Re-enter password to reveal secret key"
                value={secretPassword}
                onChange={(event) => setSecretPassword(event.target.value)}
              />
              <button className="primary" onClick={handleRevealSecret}>Reveal secret key</button>
              {secretKey ? <button className="ghost" onClick={handleCopySecret}>Copy secret key</button> : null}
              {secretKey ? <code className="secret-box">{secretKey}</code> : <p className="meta-text">Hidden</p>}
            </div>
          </article>

          <article className="request-card">
            <h2>Seed phrase (secure reveal + import)</h2>
            <p className="meta-text">Default derivation path mirrors wallet CLI: <code>m/44'/930'/0'/0'/0'</code>.</p>
            <div className="form-grid">
              <input
                type="password"
                placeholder="Re-enter password to reveal seed phrase"
                value={mnemonicPassword}
                onChange={(event) => setMnemonicPassword(event.target.value)}
              />
              <button className="primary" onClick={handleRevealMnemonic}>Reveal seed phrase</button>
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
              <button className="ghost" onClick={handleImportMnemonic}>Import seed phrase</button>
              <button className="ghost" onClick={handleGenerateMnemonicWallet}>Generate new wallet + seed</button>
              {mnemonicPhrase ? <code className="secret-box">{mnemonicPhrase}</code> : <p className="meta-text">Hidden</p>}
            </div>
          </article>

          <article className="request-card">
            <h2>Builder credit write checklist</h2>
            <dl>
              <div>
                <dt>Required field</dt>
                <dd><code>payload.credit_grant_id</code></dd>
              </div>
              <div>
                <dt>Optional sponsor</dt>
                <dd><code>payload.sponsor_builder_id</code> (defaults to signing account)</dd>
              </div>
              <div>
                <dt>Namespace focus</dt>
                <dd><code>builder.credits</code> grant + sponsorship entries</dd>
              </div>
            </dl>
          </article>

          <article className="request-card">
            <h2>Sponsorship draft builder</h2>
            <p className="meta-text">Creates strict <code>builder.credits</code> payload templates for grant issuance and sponsorship usage.</p>
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

          <article className="request-card">
            <h2>Active account</h2>
            <dl>
              <div>
                <dt>Address</dt>
                <dd>{mask(state.account)}</dd>
              </div>
              <div>
                <dt>Capabilities</dt>
                <dd>citizen_accounts, citizen_requestAccounts, personal_sign</dd>
              </div>
              <div>
                <dt>Behavior</dt>
                <dd>Signs any namespace challenge submitted by the demo app when unlocked</dd>
              </div>
            </dl>
          </article>

          <article className="request-card">
            <h2>Last dApp request</h2>
            {state.lastRequest ? (
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
            ) : (
              <p>No signing requests yet.</p>
            )}
          </article>
        </div>
      </section>
    </main>
  );
}
