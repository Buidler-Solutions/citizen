'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';

type ExplorerShellProps = {
  children: ReactNode;
};

const navItems = [
  { icon: '⌂', label: 'Dashboard', href: '/' },
  { icon: '◈', label: 'Blocks', href: '/blocks' },
  { icon: '⌗', label: 'Data Hash', href: '/data-hash' },
];

type NetworkOption = {
  id: 'localnet' | 'testnet' | 'futurenet' | 'mainnet';
  label: string;
  url: string;
};

type NetworkHealth = {
  healthy: boolean;
  checkedAtMs: number;
};

export function ExplorerShell({ children }: ExplorerShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isDark, setIsDark] = useState(true);
  const [searchValue, setSearchValue] = useState('');
  const networkOptions = useMemo<NetworkOption[]>(() => {
    const runtimeFallback = (process.env.NEXT_PUBLIC_NODE_RUNTIME_URL ?? 'http://127.0.0.1:8081').trim();
    const localnetUrl = (process.env.NEXT_PUBLIC_LOCALNET_URL ?? runtimeFallback).trim();
    const testnetUrl = (process.env.NEXT_PUBLIC_TESTNET_URL ?? '').trim();
    const futurenetUrl = (process.env.NEXT_PUBLIC_FUTURENET_URL ?? '').trim();
    const mainnetUrl = (process.env.NEXT_PUBLIC_MAINNET_URL ?? '').trim();
    return [
      { id: 'localnet', label: 'Local Node', url: localnetUrl },
      { id: 'testnet', label: 'Testnet', url: testnetUrl },
      { id: 'futurenet', label: 'Futurenet', url: futurenetUrl },
      { id: 'mainnet', label: 'Mainnet', url: mainnetUrl },
    ];
  }, []);
  const [selectedNetworkId, setSelectedNetworkId] = useState<NetworkOption['id']>('localnet');
  const [networkHealthById, setNetworkHealthById] = useState<Record<string, NetworkHealth>>({});
  const [showNetworkSuggestion, setShowNetworkSuggestion] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const storedTheme = window.localStorage.getItem('citizen.explorer.theme');
    if (storedTheme === 'light') {
      setIsDark(false);
    }

    const storedSidebar = window.localStorage.getItem('citizen.explorer.sidebar');
    if (storedSidebar === 'collapsed') {
      setSidebarCollapsed(true);
    }

    const storedNetwork = window.localStorage.getItem('citizen.explorer.network');
    if (
      storedNetwork === 'localnet' ||
      storedNetwork === 'testnet' ||
      storedNetwork === 'futurenet' ||
      storedNetwork === 'mainnet'
    ) {
      setSelectedNetworkId(storedNetwork);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem('citizen.explorer.theme', isDark ? 'dark' : 'light');
  }, [isDark]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem('citizen.explorer.sidebar', sidebarCollapsed ? 'collapsed' : 'expanded');
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    window.localStorage.setItem('citizen.explorer.network', selectedNetworkId);
  }, [selectedNetworkId]);

  const themeClass = isDark ? 'theme-dark' : 'theme-light';
  const activePath = useMemo(() => pathname ?? '/', [pathname]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const activeQuery = params.get('q') ?? '';
    setSearchValue(activeQuery);
  }, [pathname]);

  useEffect(() => {
    let cancelled = false;

    const checkHealth = async () => {
      const checks = await Promise.all(networkOptions.map(async (network) => {
        if (!network.url) {
          return [network.id, { healthy: false, checkedAtMs: Date.now() }] as const;
        }
        try {
          const response = await fetch(`${network.url.replace(/\/$/, '')}/health`, { cache: 'no-store' });
          if (!response.ok) {
            return [network.id, { healthy: false, checkedAtMs: Date.now() }] as const;
          }
          const payload = (await response.json()) as { status?: unknown };
          return [network.id, { healthy: payload?.status === 'ok', checkedAtMs: Date.now() }] as const;
        } catch {
          return [network.id, { healthy: false, checkedAtMs: Date.now() }] as const;
        }
      }));

      if (cancelled) {
        return;
      }

      setNetworkHealthById(Object.fromEntries(checks));
    };

    void checkHealth();
    const timer = window.setInterval(() => {
      void checkHealth();
    }, 15000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [networkOptions]);

  const recommendedNetworkId = useMemo<NetworkOption['id'] | null>(() => {
    const preferenceOrder: NetworkOption['id'][] = ['mainnet', 'futurenet', 'testnet', 'localnet'];
    for (const id of preferenceOrder) {
      if (networkHealthById[id]?.healthy) {
        return id;
      }
    }
    return null;
  }, [networkHealthById]);

  useEffect(() => {
    if (recommendedNetworkId && recommendedNetworkId !== selectedNetworkId) {
      setShowNetworkSuggestion(true);
      return;
    }
    setShowNetworkSuggestion(false);
  }, [recommendedNetworkId, selectedNetworkId]);

  const selectedNetwork = networkOptions.find((network) => network.id === selectedNetworkId) ?? networkOptions[0];
  const selectedNetworkHealthy = selectedNetwork ? (networkHealthById[selectedNetwork.id]?.healthy ?? false) : false;
  const recommendedNetwork = recommendedNetworkId
    ? networkOptions.find((network) => network.id === recommendedNetworkId) ?? null
    : null;

  const onSearchSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const normalizedQuery = searchValue.trim();
    if (!normalizedQuery) {
      return;
    }

    const query = new URLSearchParams();
    const dataHashMatch = /^(data_hash|datahash):(.+)$/i.exec(normalizedQuery);
    const rawSha256Match = /^([a-f0-9]{64})$/i.exec(normalizedQuery);
    const legacySha256PrefixedMatch = /^sha256:([a-f0-9]{64})$/i.exec(normalizedQuery);
    const entryIdMatch = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.exec(normalizedQuery);
    const blocksMatch = /^blocks:(\d+)$/i.exec(normalizedQuery);
    if (dataHashMatch) {
      const value = dataHashMatch[2].trim();
      if (/^[a-f0-9]{64}$/i.test(value)) {
        query.set('q', `sha256:${value}`);
      } else {
        query.set('q', value);
      }
      router.push(`/data-hash?${query.toString()}`);
      return;
    }
    if (rawSha256Match) {
      query.set('q', `sha256:${rawSha256Match[1]}`);
      router.push(`/data-hash?${query.toString()}`);
      return;
    }
    // Backwards compatibility: still accept the older prefixed form.
    if (legacySha256PrefixedMatch) {
      query.set('q', `sha256:${legacySha256PrefixedMatch[1]}`);
      router.push(`/data-hash?${query.toString()}`);
      return;
    }
    if (entryIdMatch) {
      router.push(`/entry/${encodeURIComponent(entryIdMatch[0])}`);
      return;
    }
    if (blocksMatch) {
      router.push(`/blocks/${blocksMatch[1]}`);
      return;
    }
    query.set('q', normalizedQuery);
    router.push(`/blocks?${query.toString()}`);
  };

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
          {navItems.map((item) => {
            const isActive = item.href === '/'
              ? activePath === '/'
              : activePath.startsWith(item.href);

            return (
              <Link key={item.label} className={`nav-item ${isActive ? 'active' : ''}`} href={item.href}>
                <span>{item.icon}</span>
                {!sidebarCollapsed && <span>{item.label}</span>}
              </Link>
            );
          })}
        </nav>

        <div className="left-nav-footer">
          <button type="button" className="mode-pill" onClick={() => setIsDark(false)}>
            ☼ {!sidebarCollapsed && 'Light'}
          </button>
          <button type="button" className="mode-pill" onClick={() => setIsDark(true)}>
            ☾ {!sidebarCollapsed && 'Dark'}
          </button>
        </div>
      </aside>

      <section className="dashboard-content">
        <header className="top-bar">
          <div className="top-bar-search">
            <form className="header-search-form" onSubmit={onSearchSubmit}>
              <label className="sr-only" htmlFor="top-bar-search-query">
                Search query
              </label>
              <input
                id="top-bar-search-query"
                className="header-search-input"
                type="search"
                value={searchValue}
                onChange={(event) => setSearchValue(event.target.value)}
                placeholder="Search entry IDs, hex hashes, blocks:42, or data_hash:<hex>..."
              />
              <button type="submit" className="header-search-button">
                Search
              </button>
            </form>
          </div>
          <div className="network-picker-shell">
            <label htmlFor="network-select" className="network-picker-label">Ledger Network</label>
            <select
              id="network-select"
              className="network-picker-select"
              value={selectedNetworkId}
              onChange={(event) => {
                const selectedId = event.target.value as NetworkOption['id'];
                setSelectedNetworkId(selectedId);
                setShowNetworkSuggestion(false);
              }}
            >
              {networkOptions.map((network) => (
                <option key={network.id} value={network.id} disabled={!network.url}>
                  {network.label}{network.url ? '' : ' (not configured)'}
                </option>
              ))}
            </select>
            <span className={`network-health-chip ${selectedNetworkHealthy ? 'healthy' : 'unhealthy'}`}>
              {selectedNetworkHealthy ? 'Healthy' : 'Running local'}
            </span>
          </div>
        </header>
        {showNetworkSuggestion && recommendedNetwork && selectedNetwork && (
          <div className="network-modal-backdrop" role="dialog" aria-modal="true" aria-live="assertive">
            <div className="network-modal-card">
              <h2>Network health recommendation</h2>
              <p>
                Active healthy network detected: <strong>{recommendedNetwork.label}</strong>.
                {' '}Current selection: <strong>{selectedNetwork.label}</strong>.
              </p>
              <p className="network-modal-note">
                Select the healthy network to keep explorer reads aligned with the active ledger.
              </p>
              <div className="network-modal-actions">
                <button
                  type="button"
                  className="header-search-button"
                  onClick={() => {
                    setSelectedNetworkId(recommendedNetwork.id);
                    setShowNetworkSuggestion(false);
                  }}
                >
                  Switch to {recommendedNetwork.label}
                </button>
                <button type="button" className="mode-pill" onClick={() => setShowNetworkSuggestion(false)}>
                  Keep current selection
                </button>
              </div>
            </div>
          </div>
        )}
        {children}
      </section>
    </main>
  );
}
