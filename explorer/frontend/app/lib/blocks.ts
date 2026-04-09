const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:3001';

type CommitProof = {
  aggregated_signature: string;
};

export type BlockSummary = {
  height: number;
  header: {
    timestamp: number;
    proposer: string;
    prev_hash: string;
    entry_root: string;
    commit_proof: CommitProof;
  };
  entry_count: number;
};

export type BlocksPageResponse = {
  source: string;
  data: {
    items: BlockSummary[];
    next_cursor: string | null;
    has_more: boolean;
  };
};

export type BlockDetailResponse = {
  source: string;
  data: {
    height: number;
    block: {
      header: {
        height: number;
        prev_hash: string;
        entry_root: string;
        proposer: string;
        timestamp: number;
        commit_proof: CommitProof;
      };
      entries: unknown[];
    } | null;
  };
};

export type BlockPageResult =
  | { ok: true; payload: BlocksPageResponse }
  | { ok: false; message: string };

export async function fetchBlocksPage(
  cursor?: string,
  limit = 20,
): Promise<BlockPageResult> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) {
    query.set('cursor', cursor);
  }

  try {
    const response = await fetch(`${apiBase}/blocks?${query.toString()}`, {
      cache: 'no-store',
    });

    if (!response.ok) {
      return {
        ok: false,
        message: `Backend returned ${response.status} for /blocks pagination endpoint.`,
      };
    }

    const payload = (await response.json()) as BlocksPageResponse;
    return { ok: true, payload };
  } catch {
    return {
      ok: false,
      message: 'Could not reach explorer backend /blocks pagination endpoint.',
    };
  }
}

export async function fetchBlockByHeight(
  height: number,
): Promise<BlockDetailResponse | null> {
  try {
    const response = await fetch(`${apiBase}/blocks/${height}`, {
      cache: 'no-store',
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as BlockDetailResponse;
  } catch {
    return null;
  }
}
