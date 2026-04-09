'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

type ExplorerShellProps = {
  children: ReactNode;
};

const navItems = [
  { icon: '⌂', label: 'Dashboard', href: '/' },
  { icon: '◈', label: 'Blocks', href: '/blocks' },
];

export function ExplorerShell({ children }: ExplorerShellProps) {
  const pathname = usePathname();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isDark, setIsDark] = useState(true);

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
          <div className="search-shell">Citizen Protocol Explorer</div>
          <button type="button" className="wallet-button">WALLET CONNECT</button>
        </header>
        {children}
      </section>
    </main>
  );
}
