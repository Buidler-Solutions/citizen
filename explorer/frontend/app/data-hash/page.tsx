import Link from 'next/link';
import { fetchDataHashLookup } from '../lib/data-hash';
import { toReadableDate } from '../lib/format';

export const dynamic = 'force-dynamic';

export default async function DataHashPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedParams = await searchParams;
  const queryValue = resolvedParams.q;
  const dataHash = typeof queryValue === 'string' ? queryValue : '';

  const result = dataHash ? await fetchDataHashLookup(dataHash) : null;

  return (
    <>
      <section className="hero compact">
        <div>
          <p className="eyebrow">Citizen Explorer</p>
          <h1>Data Hash Lookup</h1>
          <p className="subtitle">
            Query encrypted-ledger matches by `data_hash` across payload commitments and consent receipts.
          </p>
        </div>
      </section>

      {!dataHash ? (
        <section className="panel-card">
          <h2>Enter a hash</h2>
          <p className="subtitle">Add a `q` query value, for example `/data-hash?q=sha256:abc123...`.</p>
        </section>
      ) : !result || !result.ok ? (
        <section className="panel-card">
          <h2>Lookup failed</h2>
          <p className="subtitle">{result?.message ?? 'Unable to resolve data hash lookup.'}</p>
        </section>
      ) : (
        <section className="block-list">
          <article className="block-card">
            <div className="block-card-header">
              <h2>{result.payload.data.data_hash}</h2>
              <span className="status-chip ok">
                {result.payload.data.matches.length} match{result.payload.data.matches.length === 1 ? '' : 'es'}
              </span>
            </div>
            <p className="subtitle">Source: {result.payload.source}</p>
          </article>

          {result.payload.data.matches.map((match) => (
            <article key={`${match.entry_id}-${match.source}`} className="block-card">
              <div className="block-card-header">
                <h2>{match.namespace}</h2>
                <span className="status-chip ok">{match.source}</span>
              </div>
              <div className="stack">
                <div className="row">
                  <span className="label">Entry ID</span>
                  <Link href={`/blocks?q=${encodeURIComponent(match.entry_id)}`} className="mono">
                    {match.entry_id}
                  </Link>
                </div>
                <div className="row">
                  <span className="label">Action</span>
                  <span>{match.action}</span>
                </div>
                <div className="row">
                  <span className="label">Object</span>
                  <span>{match.object_id}</span>
                </div>
                <div className="row">
                  <span className="label">Timestamp</span>
                  <span>{toReadableDate(match.timestamp)}</span>
                </div>
              </div>
            </article>
          ))}
        </section>
      )}
    </>
  );
}
