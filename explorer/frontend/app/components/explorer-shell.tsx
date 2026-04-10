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

export function ExplorerShell({ children }: ExplorerShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isDark, setIsDark] = useState(true);
  const [searchValue, setSearchValue] = useState('');

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
            <div className="search-shell">Citizen Protocol Explorer</div>
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
                placeholder="Search e.g. <64-char hex> blocks:42 or data_hash:<64-char hex>..."
              />
              <button type="submit" className="header-search-button">
                Search
              </button>
            </form>
          </div>
          <button type="button" className="wallet-button">WALLET CONNECT</button>
        </header>
        {children}
      </section>
    </main>
  );
}
