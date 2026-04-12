const explorerBackendBase =
  process.env.NEXT_PUBLIC_EXPLORER_BACKEND_URL ?? 'http://127.0.0.1:4444';
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
  entry_ids: string[];
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
  items?: unknown[];
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
    const normalizedItems = normalizeBlockSummaryItems(nested.items as unknown[]);
    const normalizedNextCursor =
      typeof nested.next_cursor === 'string' || nested.next_cursor === null ? nested.next_cursor : null;
    const normalizedHasMore =
      typeof nested.has_more === 'boolean' ? nested.has_more : normalizedNextCursor !== null;
    return {
      source: typeof envelope.source === 'string' ? envelope.source : `${sourceBase.replace(/\/$/, '')}/blocks`,
      data: {
        items: normalizedItems,
        next_cursor: normalizedNextCursor,
        has_more: normalizedHasMore,
      },
    };
  }

  if (Array.isArray(topLevelItems)) {
    const normalizedItems = normalizeBlockSummaryItems(topLevelItems);
    const normalizedNextCursor =
      typeof envelope.next_cursor === 'string' || envelope.next_cursor === null ? envelope.next_cursor : null;
    const normalizedHasMore =
      typeof envelope.has_more === 'boolean' ? envelope.has_more : normalizedNextCursor !== null;
    return {
      source: typeof envelope.source === 'string' ? envelope.source : `${sourceBase.replace(/\/$/, '')}/blocks`,
      data: {
        items: normalizedItems,
        next_cursor: normalizedNextCursor,
        has_more: normalizedHasMore,
      },
    };
  }

  return null;
}

function normalizeBlockSummaryItems(rawItems: unknown[]): BlockSummary[] {
  return rawItems
    .map((item) => normalizeBlockSummaryItem(item))
    .filter((item): item is BlockSummary => item !== null);
}

function normalizeBlockSummaryItem(raw: unknown): BlockSummary | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const value = raw as Record<string, unknown>;
  const block = value.block && typeof value.block === 'object'
    ? (value.block as Record<string, unknown>)
    : null;
  const headerCandidate = value.header && typeof value.header === 'object'
    ? (value.header as Record<string, unknown>)
    : block?.header && typeof block.header === 'object'
      ? (block.header as Record<string, unknown>)
      : null;
  const commitProofCandidate = headerCandidate?.commit_proof && typeof headerCandidate.commit_proof === 'object'
    ? (headerCandidate.commit_proof as Record<string, unknown>)
    : null;

  const height =
    typeof value.height === 'number'
      ? value.height
      : typeof headerCandidate?.height === 'number'
        ? headerCandidate.height
        : null;
  const timestamp = typeof headerCandidate?.timestamp === 'number' ? headerCandidate.timestamp : null;
  const proposer = typeof headerCandidate?.proposer === 'string' ? headerCandidate.proposer : null;
  const prevHash = typeof headerCandidate?.prev_hash === 'string' ? headerCandidate.prev_hash : null;
  const entryRoot = typeof headerCandidate?.entry_root === 'string' ? headerCandidate.entry_root : null;
  const aggregatedSignature = typeof commitProofCandidate?.aggregated_signature === 'string'
    ? commitProofCandidate.aggregated_signature
    : null;
  const entryCount =
    typeof value.entry_count === 'number'
      ? value.entry_count
      : Array.isArray(block?.entries)
        ? block.entries.length
        : null;
  const entryIds = extractEntryIds(block?.entries);

  if (
    height === null ||
    timestamp === null ||
    proposer === null ||
    prevHash === null ||
    entryRoot === null ||
    aggregatedSignature === null ||
    entryCount === null
  ) {
    return null;
  }

  return {
    height,
    header: {
      timestamp,
      proposer,
      prev_hash: prevHash,
      entry_root: entryRoot,
      commit_proof: {
        aggregated_signature: aggregatedSignature,
      },
    },
    entry_count: entryCount,
    entry_ids: entryIds,
  };
}

function extractEntryIds(entries: unknown): string[] {
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }

      const entryId = (entry as { entry_id?: unknown }).entry_id;
      return typeof entryId === 'string' && entryId.trim().length > 0 ? entryId : null;
    })
    .filter((entryId): entryId is string => entryId !== null);
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
    const response = await fetch(`${explorerBackendBase.replace(/\/$/, '')}/blocks?${query.toString()}`, {
      cache: 'no-store',
    });

    if (response.ok) {
      const rawPayload = await response.json();
      const normalizedPayload = normalizeBlocksPageResponse(rawPayload, explorerBackendBase);
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
    const response = await fetch(`${explorerBackendBase.replace(/\/$/, '')}/blocks/${height}`, {
      cache: 'no-store',
    });

    if (response.ok) {
      const rawPayload = await response.json();
      const normalizedPayload = normalizeBlockDetailResponse(rawPayload, explorerBackendBase, height);
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
        entry_ids: extractEntryIds(lookup.block.entries),
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

    const payload = await response.json();
    const normalized = normalizeBlockDetailResponse(payload, nodeRuntimeBase, height);
    if (!normalized) {
      return null;
    }
    return {
      height: normalized.data.height,
      block: normalized.data.block,
    };
  } catch {
    return null;
  }
}
