'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ADMIN_TOKEN_KEY } from './admin-auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface StatsResponse {
  totalInterestSubmissions: number;
}

export function AdminDashboard() {
  const router = useRouter();
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const token = localStorage.getItem(ADMIN_TOKEN_KEY);

    if (!token) {
      router.replace('/admin/login');
      return;
    }

    const loadStats = async () => {
      try {
        const response = await fetch(`${API_URL}/interest/stats`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (response.status === 401) {
          localStorage.removeItem(ADMIN_TOKEN_KEY);
          router.replace('/admin/login');
          return;
        }

        if (!response.ok) {
          throw new Error('Unable to load admin stats');
        }

        const data = (await response.json()) as StatsResponse;
        setStats(data);
      } catch (statsError) {
        setError(statsError instanceof Error ? statsError.message : 'Unknown dashboard error');
      }
    };

    loadStats();
  }, [router]);

  const logout = () => {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    router.push('/admin/login');
  };

  return (
    <section className="admin-panel">
      <h1>Admin Dashboard</h1>
      <p>Authenticated stats from the protected backend endpoint.</p>

      {error && <p className="status error">{error}</p>}

      {!error && !stats && <p className="status">Loading stats...</p>}

      {stats && (
        <div className="stats-card">
          <h2>Total Interest Submissions</h2>
          <strong>{stats.totalInterestSubmissions}</strong>
        </div>
      )}

      <button type="button" onClick={logout}>Sign out</button>
    </section>
  );
}
