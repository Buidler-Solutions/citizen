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

type CitizenSigner = {
  did?: string;
  verifyingKey?: string;
  algorithm?: string;
};

type CitizenChallengeSignature = {
  signature?: string;
  algorithm?: string;
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

  const deriveCitizenAddress = useCallback(async (publicKeyHex: string) => {
    const normalized = publicKeyHex.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(normalized)) {
      throw new Error('Wallet returned an invalid Ed25519 public key.');
    }
    const keyBytes = Uint8Array.from(
      normalized.match(/.{1,2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
    );
    const digest = await crypto.subtle.digest('SHA-256', keyBytes);
    const digestHex = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    return `ctzn:${digestHex.slice(0, 40)}`;
  }, []);

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
      const signerResult = await provider.request({ method: 'ctzn_getCitizenSigner' }) as CitizenSigner;
      const signerDid = typeof signerResult?.did === 'string' ? signerResult.did.trim() : '';
      if (!signerDid) {
        setWallet(null);
        setStatus('Wallet session found, but no active protocol signer. Reconnect your wallet.');
        return;
      }
      setWallet(signerDid);
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

      const signerResult = await provider.request({ method: 'ctzn_getCitizenSigner' }) as CitizenSigner;
      const signerDid = typeof signerResult?.did === 'string' ? signerResult.did.trim() : '';
      const signerPublicKey = typeof signerResult?.verifyingKey === 'string'
        ? signerResult.verifyingKey.trim().toLowerCase()
        : '';
      if (!signerDid || !signerPublicKey) {
        throw new Error('Wallet did not return a protocol signer DID/public key.');
      }
      if (signerResult.algorithm && signerResult.algorithm.toLowerCase() !== 'ed25519') {
        throw new Error('Wallet signer algorithm must be Ed25519.');
      }
      const citizenAddress = await deriveCitizenAddress(signerPublicKey);

      const challengeResponse = await fetch(`${authApiUrl}/auth/challenge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          address: citizenAddress,
          domain: window.location.host,
          uri: `${window.location.origin}/onboarding`,
          chainId: 3096,
          scheme: 'citizen_ed25519',
          publicKey: signerPublicKey,
        }),
      });
      if (!challengeResponse.ok) {
        throw new Error(`Challenge request failed with status ${challengeResponse.status}.`);
      }
      const challenge = (await challengeResponse.json()) as WalletAuthChallengeResponse;

      const signatureResult = await provider.request({
        method: 'ctzn_signAuthChallenge',
        params: [challenge.message],
      }) as CitizenChallengeSignature;
      const signature = typeof signatureResult?.signature === 'string' ? signatureResult.signature.trim() : '';
      if (!signature) {
        throw new Error('Wallet returned an invalid auth challenge signature.');
      }

      const verifyResponse = await fetch(`${authApiUrl}/auth/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          message: challenge.message,
          address: citizenAddress,
          signature,
          scheme: 'citizen_ed25519',
          publicKey: signerPublicKey,
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
