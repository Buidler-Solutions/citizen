'use client';

import { useMemo, useState } from 'react';
import { WalletAuthClientError, createWalletAuthClient } from '@citizen/wallet-auth-typescript';

export function WalletOnboardingLogin() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [status, setStatus] = useState('Connect your wallet to continue onboarding.');
  const [busy, setBusy] = useState(false);

  const authClient = useMemo(() => createWalletAuthClient({
    authApiUrl: process.env.NEXT_PUBLIC_WALLET_AUTH_API_URL ?? 'http://127.0.0.1:4499',
    onboardingPath: '/onboarding',
    network: 'futurenet',
    storageKey: 'citizen.wallet.auth.session',
  }), []);

  const connectAndLogin = async () => {
    setBusy(true);
    setStatus('Connecting wallet and requesting one-time login challenge...');

    try {
      const result = await authClient.loginWithBrowserWallet();
      setWallet(result.wallet);
      setStatus('Wallet login successful. Your onboarding session is active.');
    } catch (error) {
      const message = error instanceof WalletAuthClientError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Unknown wallet login error.';
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
        {busy ? 'Connecting…' : wallet ? `Wallet · ${wallet.slice(0, 6)}…${wallet.slice(-4)}` : 'Login · Wallet'}
      </button>
      <p className="max-w-[20rem] text-right text-[0.65rem] leading-relaxed tracking-[0.04em] text-slate-300/80">{status}</p>
    </div>
  );
}
