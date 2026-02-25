'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ADMIN_TOKEN_KEY } from './admin-auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export function AdminLoginForm() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setLoading(true);

    const formData = new FormData(event.currentTarget);
    const payload = {
      adminKey: String(formData.get('adminKey') ?? ''),
      subject: String(formData.get('subject') ?? '').trim() || 'landing-admin',
    };

    try {
      const response = await fetch(`${API_URL}/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error('Invalid admin credentials');
      }

      const data = (await response.json()) as { accessToken?: string };

      if (!data.accessToken) {
        throw new Error('Token missing in response');
      }

      localStorage.setItem(ADMIN_TOKEN_KEY, data.accessToken);
      router.push('/admin/dashboard/applicants');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form className="admin-panel" onSubmit={submit}>
      <h1>Admin Login</h1>
      <p>Use the configured JWT admin key to generate a bearer token.</p>
      <input name="subject" placeholder="Subject (optional)" />
      <input name="adminKey" type="password" placeholder="Admin key" required />
      <button type="submit" disabled={loading}>{loading ? 'Signing in...' : 'Sign in'}</button>
      {error && <p className="status error">{error}</p>}
    </form>
  );
}
