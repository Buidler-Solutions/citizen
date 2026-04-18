'use client';

import { useMemo } from 'react';

type MetricItem = { label: string; value: string; icon: string };
type ChartPanel = { title: string; primary?: string; secondary?: string; dateLabel: string; points: number[]; mode: 'bars' | 'line' };
type TransactionRow = { id: string; from: string; sizeLabel: string; ageLabel: string };
type BlockRow = { height: number; txCount: number; timestampLabel: string; sizeLabel: string };

type HomeDashboardProps = {
  topMetrics: MetricItem[];
  charts: ChartPanel[];
  transactions: TransactionRow[];
  blocks: BlockRow[];
  sourceLabel: string;
};

function normalizePoints(points: number[]): number[] {
  if (points.length === 0) return [20, 25, 30, 28, 24, 18, 12, 10];
  const max = Math.max(...points, 1);
  return points.map((point) => Math.max(8, Math.round((point / max) * 100)));
}

function lineCoordinates(points: number[]): Array<{ x: number; y: number }> {
  if (points.length === 0) {
    return [];
  }

  if (points.length === 1) {
    return [{ x: 50, y: 100 - points[0] }];
  }

  return points.map((point, index) => ({
    x: (index / (points.length - 1)) * 100,
    y: 100 - point,
  }));
}

export function HomeDashboard({ topMetrics, charts, transactions, blocks, sourceLabel }: HomeDashboardProps) {
  const chartData = useMemo(() => charts.map((chart) => ({ ...chart, points: normalizePoints(chart.points) })), [charts]);

  return (
    <>
      <section className="hero compact">
        <div>
          <p className="eyebrow">Citizen Explorer</p>
          <h1>Dashboard</h1>
          <p className="subtitle">Network activity, recent transactions, and finality snapshots.</p>
          <p className="panel-secondary">Metric source: {sourceLabel}</p>
        </div>
      </section>

      <section className="metrics-grid">
        {topMetrics.map((metric) => (
          <article key={metric.label} className="metric-card">
            <span className="metric-icon">{metric.icon}</span>
            <div>
              <p>{metric.label}</p>
              <strong>{metric.value}</strong>
            </div>
          </article>
        ))}
      </section>

      <section className="charts-grid">
        {chartData.map((chart) => (
          <article key={chart.title} className="panel-card">
            <div className="panel-head">
              <h2>{chart.title}</h2>
              <span>⤢</span>
            </div>
            {chart.primary ? <p className="panel-primary">{chart.primary}</p> : null}
            {chart.secondary && <p className="panel-secondary">{chart.secondary}</p>}
            <p className="panel-date">{chart.dateLabel}</p>
            {chart.mode === 'line' ? (
              <div className="chart-frame line">
                {(() => {
                  const coords = lineCoordinates(chart.points);
                  if (coords.length === 0) {
                    return null;
                  }

                  const linePath = coords
                    .map((coord, idx) => `${idx === 0 ? 'M' : 'L'} ${coord.x} ${coord.y}`)
                    .join(' ');
                  const areaPath = `M ${coords[0].x} 100 ${coords
                    .map((coord) => `L ${coord.x} ${coord.y}`)
                    .join(' ')} L ${coords[coords.length - 1].x} 100 Z`;
                  const gradientId = `chart-gradient-${chart.title
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '-')
                    .replace(/(^-|-$)/g, '')}`;

                  return (
                    <svg className="chart-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                      <defs>
                        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
                          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.03" />
                        </linearGradient>
                      </defs>
                      <path d={areaPath} fill={`url(#${gradientId})`} className="chart-area" />
                      <path d={linePath} className="chart-line" />
                      {coords.map((coord, idx) => (
                        <circle key={`${chart.title}-pt-${idx}`} cx={coord.x} cy={coord.y} r="1.7" className="chart-point" />
                      ))}
                    </svg>
                  );
                })()}
              </div>
            ) : (
              <div className="chart-frame bars">
                {chart.points.map((value, idx) => (
                  <span key={`${chart.title}-${idx}`} style={{ height: `${value}%` }} />
                ))}
              </div>
            )}
          </article>
        ))}
      </section>

      <section className="lists-grid">
        <article className="panel-card list-card">
          <div className="panel-head">
            <h2>Transactions</h2>
            <a href="#">View All</a>
          </div>
          <ul>
            {transactions.map((tx) => (
              <li key={tx.id}>
                <span className="list-icon">⇄</span>
                <div className="list-main">
                  <p>{tx.id}</p>
                  <small>From: {tx.from}</small>
                </div>
                <div className="list-meta">
                  <strong>{tx.sizeLabel}</strong>
                  <small>{tx.ageLabel}</small>
                </div>
              </li>
            ))}
          </ul>
        </article>

        <article className="panel-card list-card">
          <div className="panel-head">
            <h2>Blocks</h2>
            <a href="/blocks">View All</a>
          </div>
          <ul>
            {blocks.map((block) => (
              <li key={block.height}>
                <div className="list-main">
                  <p>#{block.height.toLocaleString('en-US')}</p>
                  <small>{block.txCount} Transactions</small>
                </div>
                <div className="list-meta">
                  <strong>{block.sizeLabel}</strong>
                  <small>{block.timestampLabel}</small>
                </div>
              </li>
            ))}
          </ul>
        </article>
      </section>
    </>
  );
}
