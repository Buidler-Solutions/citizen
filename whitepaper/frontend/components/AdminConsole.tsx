'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Chapter } from '@/lib/chapters';

type AdminTokenResponse = {
  data?: {
    token?: string;
  };
};

type SectionsResponse = {
  data?: Chapter[];
};

const createEmptySection = (): Omit<Chapter, 'id'> => ({
  title: '',
  description: '',
  content: '',
  startFrame: 0,
  endFrame: 0,
  orderIndex: 1,
});


const buildApiUnavailableMessage = (apiBaseUrl: string): string =>
  `Cannot connect to the whitepaper backend at ${apiBaseUrl}. Start the NestJS backend first; if it is running, verify CORS_ORIGIN includes this frontend URL.`;

export function AdminConsole() {
  const apiBaseUrl = useMemo(() => process.env.NEXT_PUBLIC_WHITEPAPER_API_BASE_URL?.replace(/\/$/, '') ?? '', []);
  const [password, setPassword] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [sections, setSections] = useState<Chapter[]>([]);
  const [draft, setDraft] = useState<Omit<Chapter, 'id'>>(createEmptySection());
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (!apiBaseUrl || !token) return;

    void fetch(`${apiBaseUrl}/whitepaper/sections`)
      .then((response) => response.json() as Promise<SectionsResponse>)
      .then((payload) => {
        setSections(Array.isArray(payload.data) ? payload.data : []);
      })
      .catch(() => setStatus(buildApiUnavailableMessage(apiBaseUrl)));
  }, [apiBaseUrl, token]);

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!apiBaseUrl) {
      setStatus('NEXT_PUBLIC_WHITEPAPER_API_BASE_URL is not configured.');
      return;
    }

    let response: Response;
    try {
      response = await fetch(`${apiBaseUrl}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
    } catch {
      setStatus(buildApiUnavailableMessage(apiBaseUrl));
      return;
    }

    if (!response.ok) {
      setStatus('Login failed. Check admin password setup.');
      return;
    }

    const payload = (await response.json()) as AdminTokenResponse;
    if (!payload.data?.token) {
      setStatus('Login failed: no admin token returned.');
      return;
    }

    setToken(payload.data.token);
    setStatus('Admin login successful.');
  };

  const saveSection = async (sectionId?: string) => {
    if (!token || !apiBaseUrl) return;

    const endpoint = sectionId
      ? `${apiBaseUrl}/admin/whitepaper/sections/${sectionId}`
      : `${apiBaseUrl}/admin/whitepaper/sections`;

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: sectionId ? 'PATCH' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(draft),
      });
    } catch {
      setStatus(buildApiUnavailableMessage(apiBaseUrl));
      return;
    }

    if (!response.ok) {
      setStatus('Unable to save section. Verify frame range and payload.');
      return;
    }

    try {
      const refreshed = await fetch(`${apiBaseUrl}/whitepaper/sections`);
      const payload = (await refreshed.json()) as SectionsResponse;
      setSections(Array.isArray(payload.data) ? payload.data : []);
    } catch {
      setStatus('Section saved, but failed to refresh sections list.');
      return;
    }
    setDraft(createEmptySection());
    setStatus('Whitepaper section saved.');
  };

  const deleteSection = async (sectionId: string) => {
    if (!token || !apiBaseUrl) return;

    let response: Response;
    try {
      response = await fetch(`${apiBaseUrl}/admin/whitepaper/sections/${sectionId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
    } catch {
      setStatus(buildApiUnavailableMessage(apiBaseUrl));
      return;
    }

    if (!response.ok) {
      setStatus('Unable to delete section.');
      return;
    }

    setSections((current) => current.filter((section) => section.id !== sectionId));
    setStatus('Section deleted.');
  };

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6 text-slate-100">
      <h1 className="text-3xl font-semibold">Whitepaper Admin Console</h1>

      {!token ? (
        <form onSubmit={handleLogin} className="space-y-3 rounded-lg border border-slate-700 bg-slate-900/70 p-4">
          <p className="text-sm text-slate-300">Admin login is required to manage whitepaper section content.</p>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Admin password"
            className="w-full rounded border border-slate-600 bg-slate-950 px-3 py-2"
          />
          <button type="submit" className="rounded bg-cyan-500 px-4 py-2 font-medium text-slate-950">
            Login
          </button>
        </form>
      ) : (
        <div className="grid gap-6 md:grid-cols-2">
          <section className="space-y-3 rounded-lg border border-slate-700 bg-slate-900/70 p-4">
            <h2 className="text-xl font-medium">Create / Edit Section</h2>
            <input className="w-full rounded border border-slate-600 bg-slate-950 px-3 py-2" placeholder="Title" value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} />
            <textarea className="h-20 w-full rounded border border-slate-600 bg-slate-950 px-3 py-2" placeholder="Description" value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} />
            <textarea className="h-36 w-full rounded border border-slate-600 bg-slate-950 px-3 py-2" placeholder="Section content" value={draft.content ?? ''} onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))} />
            <div className="grid grid-cols-3 gap-2">
              <input type="number" className="rounded border border-slate-600 bg-slate-950 px-3 py-2" placeholder="Start frame" value={draft.startFrame} onChange={(event) => setDraft((current) => ({ ...current, startFrame: Number(event.target.value) }))} />
              <input type="number" className="rounded border border-slate-600 bg-slate-950 px-3 py-2" placeholder="End frame" value={draft.endFrame} onChange={(event) => setDraft((current) => ({ ...current, endFrame: Number(event.target.value) }))} />
              <input type="number" className="rounded border border-slate-600 bg-slate-950 px-3 py-2" placeholder="Order" value={draft.orderIndex} onChange={(event) => setDraft((current) => ({ ...current, orderIndex: Number(event.target.value) }))} />
            </div>
            <button onClick={() => void saveSection()} className="rounded bg-cyan-500 px-4 py-2 font-medium text-slate-950">Save section</button>
          </section>

          <section className="space-y-3 rounded-lg border border-slate-700 bg-slate-900/70 p-4">
            <h2 className="text-xl font-medium">Existing Sections</h2>
            <div className="space-y-2">
              {sections.map((section) => (
                <article key={section.id} className="rounded border border-slate-700 bg-slate-950 p-3">
                  <p className="text-sm text-cyan-300">#{section.orderIndex} • {section.startFrame}-{section.endFrame}</p>
                  <h3 className="font-medium">{section.title}</h3>
                  <p className="text-sm text-slate-300">{section.description}</p>
                  <div className="mt-2 flex gap-2">
                    <button className="rounded border border-slate-500 px-2 py-1 text-xs" onClick={() => setDraft({
                      title: section.title,
                      description: section.description,
                      content: section.content ?? '',
                      startFrame: section.startFrame,
                      endFrame: section.endFrame,
                      orderIndex: section.orderIndex,
                    })}>Load</button>
                    <button className="rounded border border-rose-500 px-2 py-1 text-xs text-rose-300" onClick={() => void deleteSection(section.id)}>Delete</button>
                    <button className="rounded border border-cyan-500 px-2 py-1 text-xs text-cyan-300" onClick={() => void saveSection(section.id)}>Update</button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>
      )}

      {status && <p className="text-sm text-slate-300">{status}</p>}
    </main>
  );
}
