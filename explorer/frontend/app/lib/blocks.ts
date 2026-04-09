const nodeRuntimeBase = process.env.NEXT_PUBLIC_NODE_RUNTIME_URL ?? 'http://127.0.0.1:8081';

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

type NodeBlockLookup = {
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

export type BlockPageResult =
  | { ok: true; payload: BlocksPageResponse }
  | { ok: false; message: string };

type BlocksEnvelope = {
  source?: string;
  data?: BlocksPageResponse['data'];
  items?: BlockSummary[];
  next_cursor?: string | null;
  has_more?: boolean;
};

type BlockDetailEnvelope = {
  source?: string;
  data?: BlockDetailResponse['data'];
  height?: number;
  block?: NodeBlockLookup['block'];
};

function normalizeBlocksPageResponse(
  raw: unknown,
  sourceBase: string,
): BlocksPageResponse | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const envelope = raw as BlocksEnvelope;
  const nested = envelope.data;
  const topLevelItems = envelope.items;

  if (nested && Array.isArray(nested.items)) {
    return {
      source: typeof envelope.source === 'string' ? envelope.source : `${sourceBase.replace(/\/$/, '')}/blocks`,
      data: nested,
    };
  }

  if (Array.isArray(topLevelItems)) {
    return {
      source: typeof envelope.source === 'string' ? envelope.source : `${sourceBase.replace(/\/$/, '')}/blocks`,
      data: {
        items: topLevelItems,
        next_cursor: typeof envelope.next_cursor === 'string' || envelope.next_cursor === null
          ? envelope.next_cursor
          : null,
        has_more: Boolean(envelope.has_more),
      },
    };
  }

  return null;
}

function normalizeBlockDetailResponse(
  raw: unknown,
  sourceBase: string,
  requestedHeight: number,
): BlockDetailResponse | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const envelope = raw as BlockDetailEnvelope;
  if (envelope.data && typeof envelope.data.height === 'number') {
    return {
      source: typeof envelope.source === 'string'
        ? envelope.source
        : `${sourceBase.replace(/\/$/, '')}/blocks/${envelope.data.height}`,
      data: envelope.data,
    };
  }

  const topLevelBlock = Object.prototype.hasOwnProperty.call(envelope, 'block')
    ? envelope.block ?? null
    : null;
  const topLevelHeight = typeof envelope.height === 'number' ? envelope.height : requestedHeight;

  return {
    source: typeof envelope.source === 'string'
      ? envelope.source
      : `${sourceBase.replace(/\/$/, '')}/blocks/${topLevelHeight}`,
    data: {
      height: topLevelHeight,
      block: topLevelBlock,
    },
  };
}


async function backendErrorMessage(response: Response, endpoint: string): Promise<string> {
  const base = `Node runtime returned ${response.status} for ${endpoint}.`;

  try {
    const data = (await response.clone().json()) as { message?: string; error?: string };
    const message = typeof data.message === 'string' ? data.message : data.error;
    if (typeof message === 'string' && message.trim().length > 0) {
      return `${base} ${message.trim()}`;
    }
  } catch {
    // continue to plain text fallback
  }

  try {
    const text = await response.text();
    if (text.trim().length > 0) {
      return `${base} ${text.trim()}`;
    }
  } catch {
    // keep generic message
  }

  return base;
}

export async function fetchBlocksPage(
  cursor?: string,
  limit = 20,
): Promise<BlockPageResult> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) {
    query.set('cursor', cursor);
  }

  try {
    const response = await fetch(`${nodeRuntimeBase.replace(/\/$/, '')}/blocks?${query.toString()}`, {
      cache: 'no-store',
    });

    if (response.ok) {
      const rawPayload = await response.json();
      const normalizedPayload = normalizeBlocksPageResponse(rawPayload, nodeRuntimeBase);
      if (normalizedPayload) {
        return { ok: true, payload: normalizedPayload };
      }
    }

    const fallback = await fetchBlocksPageFromNode(cursor, limit);
    if (fallback.ok) {
      return fallback;
    }

    return {
      ok: false,
      message: `${await backendErrorMessage(response, '/blocks pagination endpoint')} Height-walk fallback also failed.`,
    };
  } catch {
    return fetchBlocksPageFromNode(cursor, limit);
  }
}

export async function fetchBlockByHeight(
  height: number,
): Promise<BlockDetailResponse | null> {
  try {
    const response = await fetch(`${nodeRuntimeBase.replace(/\/$/, '')}/blocks/${height}`, {
      cache: 'no-store',
    });

    if (response.ok) {
      const rawPayload = await response.json();
      const normalizedPayload = normalizeBlockDetailResponse(rawPayload, nodeRuntimeBase, height);
      if (normalizedPayload) {
        return normalizedPayload;
      }
    }
  } catch {
    // fallback to direct node lookup below
  }

  const nodeBlock = await fetchNodeBlock(height);
  if (!nodeBlock) {
    return null;
  }

  return {
    source: `${nodeRuntimeBase.replace(/\/$/, '')}/blocks/${height}`,
    data: nodeBlock,
  };
}

async function fetchBlocksPageFromNode(
  cursor?: string,
  limit = 20,
): Promise<BlockPageResult> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) {
    query.set('cursor', cursor);
  }

  try {
    const response = await fetch(`${nodeRuntimeBase.replace(/\/$/, '')}/blocks?${query.toString()}`, {
      cache: 'no-store',
    });

    if (response.ok) {
      const rawPayload = await response.json();
      const normalizedPayload = normalizeBlocksPageResponse(rawPayload, nodeRuntimeBase);
      if (normalizedPayload) {
        return {
          ok: true,
          payload: normalizedPayload,
        };
      }
    }
  } catch {
    // continue to compatibility fallback for older runtimes
  }

  if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
    return {
      ok: false,
      message: 'Invalid blocks pagination limit. Expected 1..100.',
    };
  }

  const requestedCursor = parseCursor(cursor);
  if (requestedCursor === null && cursor) {
    return {
      ok: false,
      message: 'Invalid blocks pagination cursor. Expected a non-negative integer block height.',
    };
  }

  const latestHeight = await findLatestNodeHeight();
  if (latestHeight < 0) {
    return {
      ok: true,
      payload: {
        source: `${nodeRuntimeBase.replace(/\/$/, '')}/blocks/:height`,
        data: {
          items: [],
          next_cursor: null,
          has_more: false,
        },
      },
    };
  }

  const startHeight = requestedCursor === null ? latestHeight : Math.min(requestedCursor, latestHeight);
  if (startHeight < 0) {
    return {
      ok: true,
      payload: {
        source: `${nodeRuntimeBase.replace(/\/$/, '')}/blocks/:height`,
        data: {
          items: [],
          next_cursor: null,
          has_more: false,
        },
      },
    };
  }

  const items: BlockSummary[] = [];
  let nextHeight = startHeight;

  while (nextHeight >= 0 && items.length < limit) {
    const lookup = await fetchNodeBlock(nextHeight);
    if (lookup?.block) {
      items.push({
        height: lookup.height,
        header: lookup.block.header,
        entry_count: lookup.block.entries.length,
      });
    }

    nextHeight -= 1;
  }

  const hasMore = nextHeight >= 0;

  return {
    ok: true,
    payload: {
      source: `${nodeRuntimeBase.replace(/\/$/, '')}/blocks/:height`,
      data: {
        items,
        next_cursor: hasMore ? String(nextHeight) : null,
        has_more: hasMore,
      },
    },
  };
}

function parseCursor(cursor?: string): number | null {
  if (!cursor) {
    return null;
  }

  const parsed = Number(cursor);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}

async function findLatestNodeHeight(): Promise<number> {
  const zero = await fetchNodeBlock(0);
  const one = await fetchNodeBlock(1);

  if (!zero?.block && !one?.block) {
    return -1;
  }

  let lowerBound = one?.block ? 1 : 0;
  let upperBound = lowerBound;

  while (true) {
    const candidate = Math.max(upperBound * 2, upperBound + 1);
    const block = await fetchNodeBlock(candidate);
    if (!block?.block) {
      upperBound = candidate;
      break;
    }

    lowerBound = candidate;
    upperBound = candidate;
  }

  let left = lowerBound;
  let right = upperBound;

  while (left + 1 < right) {
    const mid = Math.floor((left + right) / 2);
    const block = await fetchNodeBlock(mid);
    if (block?.block) {
      left = mid;
    } else {
      right = mid;
    }
  }

  return left;
}

async function fetchNodeBlock(height: number): Promise<NodeBlockLookup | null> {
  try {
    const response = await fetch(`${nodeRuntimeBase.replace(/\/$/, '')}/blocks/${height}`, {
      cache: 'no-store',
    });

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }

      return null;
    }

    return (await response.json()) as NodeBlockLookup;
  } catch {
    return null;
  }
}
