export default function BlockDetailLoading() {
  return (
    <main className="page">
      <section className="hero">
        <div>
          <p className="eyebrow">Citizen Explorer</p>
          <h1>Block details</h1>
          <p className="subtitle">Loading block data…</p>
        </div>
      </section>

      <section className="card skeleton-card" aria-hidden>
        <div className="skeleton-line skeleton-line-lg" />
        <div className="skeleton-line" />
        <div className="skeleton-line" />
        <div className="skeleton-line" />
      </section>
    </main>
  );
}
