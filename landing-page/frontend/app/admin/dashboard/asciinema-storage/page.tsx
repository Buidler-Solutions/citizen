'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2, Upload } from 'lucide-react';
import { Button, Input } from '@/components/admin-ui';
import { ADMIN_TOKEN_KEY } from '@/components/admin-auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface AsciinemaRecording {
  id: string;
  shortcode: string;
  label: string;
  castUrl: string;
  filename: string;
  updatedAt: string;
}

export default function AsciinemaStoragePage() {
  const router = useRouter();
  const [recordings, setRecordings] = useState<AsciinemaRecording[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [shortcode, setShortcode] = useState('onboarding-demo');
  const [label, setLabel] = useState('');
  const [castFile, setCastFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const loadRecordings = useCallback(async (token: string) => {
    const response = await fetch(`${API_URL}/interest/asciinema-recordings`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.status === 401) {
      localStorage.removeItem(ADMIN_TOKEN_KEY);
      router.replace('/admin/login');
      return;
    }

    if (!response.ok) {
      const details = await response.text();
      throw new Error(details || 'Unable to load Asciinema storage.');
    }

    const data = (await response.json()) as AsciinemaRecording[];
    setRecordings(data);
  }, [router]);

  useEffect(() => {
    const token = localStorage.getItem(ADMIN_TOKEN_KEY);

    if (!token) {
      router.replace('/admin/login');
      return;
    }

    const load = async () => {
      try {
        await loadRecordings(token);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Unknown error.');
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [loadRecordings, router]);

  const uploadRecording = async () => {
    const token = localStorage.getItem(ADMIN_TOKEN_KEY);

    if (!token) {
      router.replace('/admin/login');
      return;
    }

    if (!castFile) {
      setStatus('Choose a .cast/.json file before uploading.');
      return;
    }

    try {
      setUploading(true);
      setStatus('Uploading Asciinema recording...');

      const formData = new FormData();
      formData.append('castFile', castFile);
      formData.append('shortcode', shortcode);
      if (label.trim()) {
        formData.append('label', label.trim());
      }

      const response = await fetch(`${API_URL}/interest/asciinema-recordings/upload`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      });

      if (response.status === 401) {
        localStorage.removeItem(ADMIN_TOKEN_KEY);
        router.replace('/admin/login');
        return;
      }

      if (!response.ok) {
        const details = await response.text();
        throw new Error(details || 'Unable to upload cast file.');
      }

      await loadRecordings(token);
      setCastFile(null);
      setStatus('Recording saved. Onboarding shortcodes are now resolved from storage.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unknown upload error.');
    } finally {
      setUploading(false);
    }
  };

  const deleteRecording = async (id: string) => {
    const token = localStorage.getItem(ADMIN_TOKEN_KEY);

    if (!token) {
      router.replace('/admin/login');
      return;
    }

    try {
      const response = await fetch(`${API_URL}/interest/asciinema-recordings/${id}`, {
        method: 'DELETE',
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
        const details = await response.text();
        throw new Error(details || 'Unable to delete recording.');
      }

      await loadRecordings(token);
      setStatus('Recording deleted.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unknown delete error.');
    }
  };

  if (loading) {
    return <div className="py-16 text-center text-slate-500">Loading Asciinema storage...</div>;
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-slate-900">Asciinema Storage</h1>
        <p className="text-sm text-slate-600">Upload and manage onboarding .cast/.json files in a dedicated storage section.</p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">Add or replace recording</h2>
        <p className="mt-1 text-sm text-slate-600">If a shortcode already exists, upload will replace the stored file URL for that shortcode.</p>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <Input label="Shortcode" value={shortcode} onChange={(event) => setShortcode(event.target.value)} placeholder="onboarding-demo" />
          <Input label="Label (optional)" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Watch terminal demo" />
        </div>

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Input type="file" accept=".cast,application/json" onChange={(event) => setCastFile(event.target.files?.[0] ?? null)} className="sm:max-w-md" />
          <Button onClick={uploadRecording} disabled={!castFile || uploading} isLoading={uploading} className="gap-2">
            <Upload className="h-4 w-4" /> Upload recording
          </Button>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">Stored files</h2>
        <div className="mt-4 space-y-3">
          {recordings.length === 0 && <p className="text-sm text-slate-500">No recordings stored yet.</p>}
          {recordings.map((recording) => (
            <div key={recording.id} className="rounded-xl border border-slate-200 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1 text-sm">
                  <p><span className="font-semibold text-slate-800">Shortcode:</span> {recording.shortcode}</p>
                  <p><span className="font-semibold text-slate-800">Label:</span> {recording.label || '—'}</p>
                  <p><span className="font-semibold text-slate-800">File:</span> {recording.filename}</p>
                  <p className="text-xs text-slate-500">URL: {recording.castUrl}</p>
                </div>
                <Button variant="outline" className="gap-2" onClick={() => void deleteRecording(recording.id)}>
                  <Trash2 className="h-4 w-4" /> Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {status && <p className="text-sm text-slate-600">{status}</p>}
    </div>
  );
}
