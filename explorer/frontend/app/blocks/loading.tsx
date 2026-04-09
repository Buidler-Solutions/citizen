export default function BlocksLoading() {
  return (
    <main className="page">
      <section className="hero">
        <div>
          <p className="eyebrow">Citizen Explorer</p>
          <h1>Blocks</h1>
          <p className="subtitle">Loading recent finalized blocks…</p>
        </div>
      </section>
      <section className="block-list" aria-hidden>
        {Array.from({ length: 5 }).map((_, index) => (
          <article key={`block-skeleton-${index}`} className="block-card skeleton-card">
            <div className="skeleton-line skeleton-line-lg" />
            <div className="skeleton-line" />
            <div className="skeleton-line" />
            <div className="skeleton-line" />
            <div className="skeleton-line" />
          </article>
        ))}
      </section>
    </main>
  );
}
