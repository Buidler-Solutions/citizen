'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface ResetPasswordFormProps {
  initialEmail: string;
  initialToken: string;
}

export function ResetPasswordForm({ initialEmail, initialToken }: ResetPasswordFormProps) {
  const [email, setEmail] = useState(initialEmail);
  const [token, setToken] = useState(initialToken);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setStatus('');

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`${API_URL}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, token, password }),
      });

      const data = (await response.json().catch(() => ({}))) as { message?: string | string[] };
      if (!response.ok) {
        const message = Array.isArray(data.message) ? data.message.join(', ') : data.message ?? 'Unable to reset password.';
        throw new Error(message);
      }

      setStatus(typeof data.message === 'string' ? data.message : 'Password reset successfully.');
      setPassword('');
      setConfirmPassword('');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Password reset failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="mx-auto max-w-xl rounded-3xl bg-white p-8 shadow-xl shadow-slate-200/60">
      <div className="mb-6 space-y-2">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-blue-600">Citizen onboarding</p>
        <h1 className="text-3xl font-bold text-slate-900">Reset your admin password</h1>
        <p className="text-sm text-slate-500">Paste the reset token from your email if the link did not prefill this form.</p>
      </div>
      <form className="space-y-4" onSubmit={submit}>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="email">Recovery email</label>
          <input id="email" className="w-full rounded-xl border border-slate-200 px-4 py-3" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="token">Reset token</label>
          <textarea id="token" className="min-h-32 w-full rounded-xl border border-slate-200 px-4 py-3" value={token} onChange={(event) => setToken(event.target.value)} required />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="password">New password</label>
          <input id="password" className="w-full rounded-xl border border-slate-200 px-4 py-3" type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} required />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="confirmPassword">Confirm new password</label>
          <input id="confirmPassword" className="w-full rounded-xl border border-slate-200 px-4 py-3" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={8} required />
        </div>
        <button className="w-full rounded-xl bg-blue-600 px-4 py-3 font-semibold text-white" type="submit" disabled={loading}>{loading ? 'Resetting password...' : 'Reset password'}</button>
      </form>
      {status && <p className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{status}</p>}
      {error && <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      <p className="mt-6 text-sm text-slate-500"><Link className="font-semibold text-blue-600" href="/admin/login">Return to login</Link></p>
    </section>
  );
}
