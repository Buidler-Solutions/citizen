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
};

function normalizePoints(points: number[]): number[] {
  if (points.length === 0) return [20, 25, 30, 28, 24, 18, 12, 10];
  const max = Math.max(...points, 1);
  return points.map((point) => Math.max(8, Math.round((point / max) * 100)));
}

export function HomeDashboard({ topMetrics, charts, transactions, blocks }: HomeDashboardProps) {
  const chartData = useMemo(() => charts.map((chart) => ({ ...chart, points: normalizePoints(chart.points) })), [charts]);

  return (
    <>
      <section className="hero compact">
        <div>
          <p className="eyebrow">Citizen Explorer</p>
          <h1>Dashboard</h1>
          <p className="subtitle">Network activity, recent transactions, and finality snapshots.</p>
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
            <div className={`chart-frame ${chart.mode === 'line' ? 'line' : 'bars'}`}>
              {chart.points.map((value, idx) => (
                <span key={`${chart.title}-${idx}`} style={{ height: `${value}%` }} />
              ))}
            </div>
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
