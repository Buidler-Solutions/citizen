'use client';

import { useMemo, useState } from 'react';

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

const navItems = [
  { icon: '▣', label: 'Addresses' },
  { icon: '⇄', label: 'Transactions' },
  { icon: '◈', label: 'Blocks' },
  { icon: '◉', label: 'Statistics' },
  { icon: '✶', label: 'Top Stats' },
  { icon: '⎔', label: 'Nodes' },
  { icon: '⌁', label: 'Gateways' },
  { icon: '⚙', label: 'Ecosystem' },
];

function normalizePoints(points: number[]): number[] {
  if (points.length === 0) return [20, 25, 30, 28, 24, 18, 12, 10];
  const max = Math.max(...points, 1);
  return points.map((point) => Math.max(8, Math.round((point / max) * 100)));
}

export function HomeDashboard({ topMetrics, charts, transactions, blocks }: HomeDashboardProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isDark, setIsDark] = useState(true);

  const themeClass = isDark ? 'theme-dark' : 'theme-light';

  const chartData = useMemo(() => charts.map((chart) => ({ ...chart, points: normalizePoints(chart.points) })), [charts]);

  return (
    <main className={`explorer-shell ${themeClass} ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className="left-nav">
        <div className="brand-row">
          {!sidebarCollapsed && <strong>CTZN</strong>}
          <button
            type="button"
            className="icon-button"
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => setSidebarCollapsed((value) => !value)}
          >
            {sidebarCollapsed ? '▸' : '◂'}
          </button>
        </div>

        <nav className="left-nav-links">
          {navItems.map((item) => (
            <a key={item.label} className="nav-item" href="#">
              <span>{item.icon}</span>
              {!sidebarCollapsed && <span>{item.label}</span>}
            </a>
          ))}
        </nav>

        <div className="left-nav-footer">
          <button type="button" className="mode-pill" onClick={() => setIsDark(false)}>☼ {!sidebarCollapsed && 'Light'}</button>
          <button type="button" className="mode-pill" onClick={() => setIsDark(true)}>☾ {!sidebarCollapsed && 'Dark'}</button>
        </div>
      </aside>

      <section className="dashboard-content">
        <header className="top-bar">
          <div className="search-shell">⌕ Search for an address, tx, block, token, name...</div>
          <button type="button" className="wallet-button">WALLET CONNECT</button>
        </header>

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
      </section>
    </main>
  );
}
