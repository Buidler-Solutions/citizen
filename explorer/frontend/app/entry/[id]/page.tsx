'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

const BACKEND = process.env.NEXT_PUBLIC_EXPLORER_BACKEND_URL ?? 'http://127.0.0.1:4444';

type EntryLookup = {
  entry_id: string;
  block_height: number;
  namespace: string;
};

export default function EntryPage() {
  const { id } = useParams<{ id: string }>();
  const [entry, setEntry] = useState<EntryLookup | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    fetch(`${BACKEND.replace(/\/$/, '')}/entries/lookup/${encodeURIComponent(id)}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Not found (${res.status})`);
        const body = await res.json();
        if (body?.data?.entry_id) {
          setEntry(body.data);
        } else {
          throw new Error('Entry not found');
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Lookup failed'));
  }, [id]);

  if (error) {
    return (
      <div style={{ padding: 40 }}>
        <h2>Entry not found</h2>
        <p className="meta-text">{error}</p>
        <a href="/" style={{ color: 'var(--accent)' }}>← Explorer Home</a>
      </div>
    );
  }

  if (!entry) {
    return <div style={{ padding: 40 }}><p>Looking up entry…</p></div>;
  }

  return (
    <div style={{ padding: 40 }}>
      <h2>Entry Lookup</h2>
      <div className="card" style={{ marginTop: 16, maxWidth: 640 }}>
        <div style={{ display: 'grid', gap: 8 }}>
          <div>
            <span className="meta-text">Entry ID</span>
            <div className="mono" style={{ wordBreak: 'break-all' }}>{entry.entry_id}</div>
          </div>
          <div>
            <span className="meta-text">Namespace</span>
            <div>{entry.namespace}</div>
          </div>
          <div>
            <span className="meta-text">Block</span>
            <div>
              <a href={`/blocks/${entry.block_height}`} style={{ color: 'var(--accent)', fontWeight: 600 }}>
                #{entry.block_height}
              </a>
            </div>
          </div>
        </div>
      </div>
      <p style={{ marginTop: 16 }}>
        <a href="/" style={{ color: 'var(--accent)' }}>← Explorer Home</a>
      </p>
    </div>
  );
}
