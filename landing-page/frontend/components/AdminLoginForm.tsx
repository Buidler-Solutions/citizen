'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ADMIN_TOKEN_KEY } from './admin-auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export function AdminLoginForm() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [forgotLoading, setForgotLoading] = useState(false);
  const [error, setError] = useState('');
  const [forgotStatus, setForgotStatus] = useState('');
  const [identifier, setIdentifier] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setLoading(true);

    const formData = new FormData(event.currentTarget);
    const username = String(formData.get('username') ?? '').trim();
    const payload = {
      username,
      password: String(formData.get('password') ?? ''),
      subject: String(formData.get('subject') ?? '').trim() || username || 'admin',
    };

    try {
      const response = await fetch(`${API_URL}/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = (await response.json().catch(() => ({}))) as { accessToken?: string; message?: string | string[] };

      if (!response.ok) {
        const message = Array.isArray(data.message) ? data.message.join(', ') : data.message ?? 'Invalid username or password';
        throw new Error(message);
      }

      if (!data.accessToken) {
        throw new Error('Token missing in response');
      }

      localStorage.setItem(ADMIN_TOKEN_KEY, data.accessToken);
      router.push('/admin/dashboard/users');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const requestReset = async () => {
    setForgotStatus('');
    setError('');
    setForgotLoading(true);

    try {
      const response = await fetch(`${API_URL}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier }),
      });

      const data = (await response.json().catch(() => ({}))) as { message?: string | string[] };

      if (!response.ok) {
        const message = Array.isArray(data.message) ? data.message.join(', ') : data.message ?? 'Unable to request password reset.';
        throw new Error(message);
      }

      setForgotStatus(typeof data.message === 'string' ? data.message : 'If the account exists, a reset link has been sent.');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Password reset request failed');
    } finally {
      setForgotLoading(false);
    }
  };

  return (
    <form className="admin-panel" onSubmit={submit}>
      <h1>Admin Console Login</h1>
      <p>Sign in with your onboarding console credentials. The configured environment admin remains the seeded super admin account.</p>
      <input name="username" placeholder="Username" required value={identifier} onChange={(event) => setIdentifier(event.target.value)} />
      <input name="password" type="password" placeholder="Password" required />
      <input name="subject" placeholder="Subject override (optional)" />
      <button type="submit" disabled={loading}>{loading ? 'Signing in...' : 'Sign in'}</button>
      <div className="status" style={{ display: 'grid', gap: 8 }}>
        <button type="button" onClick={requestReset} disabled={forgotLoading || identifier.trim().length < 3}>
          {forgotLoading ? 'Requesting reset...' : 'Forgot password'}
        </button>
        <Link href="/admin/reset-password">Already have a reset link?</Link>
      </div>
      {forgotStatus && <p className="status">{forgotStatus}</p>}
      {error && <p className="status error">{error}</p>}
    </form>
  );
}
