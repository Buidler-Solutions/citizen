'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ADMIN_TOKEN_KEY } from './admin-auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface StatsResponse {
  totalInterestSubmissions: number;
}

interface FormSettingsResponse {
  title: string;
  subtitle: string;
  validatorPrompt: string;
  builderPrompt: string;
  observerPrompt: string;
}

const DEFAULT_SETTINGS: FormSettingsResponse = {
  title: 'Build Public Truth with Citizen',
  subtitle: 'Validator · Builder · Observer onboarding',
  validatorPrompt: 'I want to stress test the system as a Validator focused on...',
  builderPrompt: 'I want to build civic applications as a Builder for...',
  observerPrompt: 'I want to run audits as an Observer to improve...',
};

export function AdminDashboard() {
  const router = useRouter();
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [error, setError] = useState('');
  const [saveStatus, setSaveStatus] = useState('');
  const [settings, setSettings] = useState<FormSettingsResponse>(DEFAULT_SETTINGS);

  useEffect(() => {
    const token = localStorage.getItem(ADMIN_TOKEN_KEY);

    if (!token) {
      router.replace('/admin/login');
      return;
    }

    const loadDashboard = async () => {
      try {
        const [statsResponse, settingsResponse] = await Promise.all([
          fetch(`${API_URL}/interest/stats`, { headers: { Authorization: `Bearer ${token}` } }),
          fetch(`${API_URL}/interest/form-settings`),
        ]);

        if (statsResponse.status === 401) {
          localStorage.removeItem(ADMIN_TOKEN_KEY);
          router.replace('/admin/login');
          return;
        }

        if (!statsResponse.ok) {
          throw new Error('Unable to load admin stats');
        }

        const statsData = (await statsResponse.json()) as StatsResponse;
        setStats(statsData);

        if (settingsResponse.ok) {
          const settingsData = (await settingsResponse.json()) as Partial<FormSettingsResponse>;
          setSettings((prev) => ({ ...prev, ...settingsData }));
        }
      } catch (statsError) {
        setError(statsError instanceof Error ? statsError.message : 'Unknown dashboard error');
      }
    };

    loadDashboard();
  }, [router]);

  const logout = () => {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    router.push('/admin/login');
  };

  const saveSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const token = localStorage.getItem(ADMIN_TOKEN_KEY);

    if (!token) {
      router.replace('/admin/login');
      return;
    }

    try {
      setSaveStatus('Saving form settings...');
      const response = await fetch(`${API_URL}/interest/form-settings`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(settings),
      });

      if (response.status === 401) {
        localStorage.removeItem(ADMIN_TOKEN_KEY);
        router.replace('/admin/login');
        return;
      }

      if (!response.ok) {
        throw new Error('Unable to save form settings');
      }

      setSaveStatus('Form settings saved. Landing page will use the new prompts.');
    } catch (saveError) {
      setSaveStatus(saveError instanceof Error ? saveError.message : 'Unknown save error');
    }
  };

  return (
    <section className="admin-panel">
      <h1>Admin Dashboard</h1>
      <p>Authenticated stats and landing form settings.</p>

      {error && <p className="status error">{error}</p>}

      {!error && !stats && <p className="status">Loading stats...</p>}

      {stats && (
        <div className="stats-card">
          <h2>Total Interest Submissions</h2>
          <strong>{stats.totalInterestSubmissions}</strong>
        </div>
      )}

      <form className="settings-form" onSubmit={saveSettings}>
        <h2>Form Settings</h2>
        <input
          value={settings.title}
          onChange={(event) => setSettings((prev) => ({ ...prev, title: event.target.value }))}
          placeholder="Form title"
        />
        <input
          value={settings.subtitle}
          onChange={(event) => setSettings((prev) => ({ ...prev, subtitle: event.target.value }))}
          placeholder="Form subtitle"
        />
        <textarea
          value={settings.validatorPrompt}
          onChange={(event) => setSettings((prev) => ({ ...prev, validatorPrompt: event.target.value }))}
          placeholder="Validator prompt"
          rows={3}
        />
        <textarea
          value={settings.builderPrompt}
          onChange={(event) => setSettings((prev) => ({ ...prev, builderPrompt: event.target.value }))}
          placeholder="Builder prompt"
          rows={3}
        />
        <textarea
          value={settings.observerPrompt}
          onChange={(event) => setSettings((prev) => ({ ...prev, observerPrompt: event.target.value }))}
          placeholder="Observer prompt"
          rows={3}
        />
        <button type="submit">Save Form Settings</button>
        {saveStatus && <p className="status">{saveStatus}</p>}
      </form>

      <button type="button" onClick={logout}>Sign out</button>
    </section>
  );
}
