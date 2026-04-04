'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

type WalletProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

type WalletAuthChallengeResponse = {
  challengeId: string;
  message: string;
};

type WalletAuthVerifyResponse = {
  token?: string;
};

const detectProvider = (): WalletProvider | null => {
  const candidate = (window as typeof window & { citizen?: WalletProvider; ctzn?: WalletProvider });
  return candidate.citizen ?? candidate.ctzn ?? null;
};

export function WalletOnboardingLogin() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [status, setStatus] = useState('Connect your wallet to continue onboarding.');
  const [busy, setBusy] = useState(false);

  const authApiUrl = useMemo(
    () => process.env.NEXT_PUBLIC_WALLET_AUTH_API_URL ?? 'http://127.0.0.1:4499',
    [],
  );

  const syncWalletHandshakeState = useCallback(async () => {
    const provider = detectProvider();
    if (!provider) {
      setWallet(null);
      setStatus('Citizen wallet extension not detected. Install and unlock to continue.');
      return;
    }

    const token = window.localStorage.getItem('citizen.wallet.auth.session');
    if (!token) {
      setWallet(null);
      setStatus('Connect your wallet to continue onboarding.');
      return;
    }

    try {
      const accountsResult = await provider.request({ method: 'citizen_accounts' });
      const accounts = Array.isArray(accountsResult) ? accountsResult : [];
      const selectedWallet = typeof accounts[0] === 'string' ? accounts[0].toLowerCase() : null;
      if (!selectedWallet) {
        setWallet(null);
        setStatus('Wallet session found, but no connected account. Reconnect your wallet.');
        return;
      }
      setWallet(selectedWallet);
      setStatus('Wallet login successful. Your onboarding session is active.');
    } catch {
      setWallet(null);
      setStatus('Wallet handshake check failed. Reconnect your wallet to continue.');
    }
  }, []);

  useEffect(() => {
    void syncWalletHandshakeState();
  }, [syncWalletHandshakeState]);

  const connectAndLogin = async () => {
    setBusy(true);
    setStatus('Connecting wallet and requesting one-time login challenge...');

    try {
      const provider = detectProvider();
      if (!provider) {
        throw new Error('Citizen wallet extension was not detected in this browser.');
      }

      const accountsResult = await provider.request({ method: 'ctzn_requestAccounts' });
      const accounts = Array.isArray(accountsResult) ? accountsResult : [];
      const selectedWallet = typeof accounts[0] === 'string' ? accounts[0] : null;
      if (!selectedWallet) {
        throw new Error('Wallet did not return an account.');
      }

      const challengeResponse = await fetch(`${authApiUrl}/auth/challenge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          wallet: selectedWallet,
          domain: window.location.host,
          uri: `${window.location.origin}/onboarding`,
          network: 'futurenet',
        }),
      });
      if (!challengeResponse.ok) {
        throw new Error(`Challenge request failed with status ${challengeResponse.status}.`);
      }
      const challenge = (await challengeResponse.json()) as WalletAuthChallengeResponse;

      const signature = await provider.request({
        method: 'personal_sign',
        params: [challenge.message, selectedWallet],
      });
      if (typeof signature !== 'string' || !signature.startsWith('0x')) {
        throw new Error('Wallet returned an invalid signature.');
      }

      const verifyResponse = await fetch(`${authApiUrl}/auth/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          wallet: selectedWallet,
          signature,
        }),
      });
      if (!verifyResponse.ok) {
        throw new Error(`Signature verification failed with status ${verifyResponse.status}.`);
      }
      const verified = (await verifyResponse.json()) as WalletAuthVerifyResponse;
      const token = typeof verified.token === 'string' ? verified.token.trim() : '';
      if (!token) {
        throw new Error('Wallet auth backend did not return a session token.');
      }
      window.localStorage.setItem('citizen.wallet.auth.session', token);

      await syncWalletHandshakeState();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown wallet login error.';
      setStatus(`Wallet login failed: ${message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        type="button"
        className="rounded-full border border-cyan-300/40 px-4 py-1.5 text-xs font-semibold tracking-[0.08em] text-cyan-200 transition-colors hover:border-cyan-200 hover:text-cyan-100 disabled:cursor-not-allowed disabled:opacity-70"
        onClick={() => {
          void connectAndLogin();
        }}
        disabled={busy}
      >
        {busy ? 'Connecting…' : wallet ? `Wallet · ${wallet.slice(0, 6)}…${wallet.slice(-4)}` : 'Connect Wallet'}
      </button>
      <p className="max-w-[20rem] text-right text-[0.65rem] leading-relaxed tracking-[0.04em] text-slate-300/80">{status}</p>
    </div>
  );
}
