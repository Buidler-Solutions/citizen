const explorerBackendBase =
  process.env.NEXT_PUBLIC_EXPLORER_BACKEND_URL ??
  'http://127.0.0.1:4444';

export type DataHashLookupResponse = {
  source: string;
  data: {
    data_hash: string;
    matches: Array<{
      entry_id: string;
      namespace: string;
      action: string;
      object_id: string;
      timestamp: number;
      source: string;
    }>;
  };
};

export type DataHashLookupResult =
  | { ok: true; payload: DataHashLookupResponse }
  | { ok: false; message: string };

export async function fetchDataHashLookup(dataHash: string): Promise<DataHashLookupResult> {
  const normalized = dataHash.trim();
  if (!normalized) {
    return { ok: false, message: 'Enter a data hash to query.' };
  }

  const endpoint = `${explorerBackendBase.replace(/\/$/, '')}/data-hash?q=${encodeURIComponent(normalized)}`;

  try {
    const response = await fetch(endpoint, { cache: 'no-store' });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      return {
        ok: false,
        message: payload?.error ?? `Lookup failed with status ${response.status}.`,
      };
    }

    const raw = (await response.json()) as unknown;
    const envelope = raw && typeof raw === 'object'
      ? (raw as { source?: string; data?: DataHashLookupResponse['data'] })
      : null;
    const nested = envelope && typeof envelope.data === 'object'
      ? envelope.data
      : (raw as DataHashLookupResponse['data']);

    if (
      !nested ||
      typeof nested !== 'object' ||
      typeof nested.data_hash !== 'string' ||
      !Array.isArray(nested.matches)
    ) {
      return { ok: false, message: 'Lookup response was missing expected data.' };
    }

    return {
      ok: true,
      payload: {
        source: envelope && typeof envelope.source === 'string' ? envelope.source : endpoint,
        data: nested,
      },
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Data-hash lookup failed unexpectedly.',
    };
  }
}
