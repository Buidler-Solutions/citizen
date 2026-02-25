'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { PropsWithChildren, useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  ChevronLeft,
  ChevronRight,
  CircleUserRound,
  FileSearch,
  Globe2,
  LayoutGrid,
  LogOut,
  Menu,
  MessageSquareMore,
  Network,
  Settings,
  Store,
  Users,
} from 'lucide-react';
import { ADMIN_TOKEN_KEY } from './admin-auth';

const NAV_GROUPS = [
  {
    label: 'People',
    items: [
      { href: '/admin/dashboard/users', label: 'Users', icon: Users },
      { href: '/admin/dashboard/networks', label: 'Networks', icon: Network },
      { href: '/admin/dashboard/countries', label: 'Countries', icon: Globe2 },
      { href: '/admin/dashboard/applicants', label: 'Applicants', icon: FileSearch },
    ],
  },
  {
    label: 'Operations',
    items: [
      { href: '/admin/dashboard/store', label: 'Store', icon: Store },
      { href: '/admin/dashboard/submissions', label: 'Submissions', icon: MessageSquareMore },
      { href: '/admin/dashboard/reports', label: 'Reports', icon: BarChart3 },
      { href: '/admin/dashboard/logo-slider', label: 'Logo Slider', icon: LayoutGrid },
    ],
  },
  {
    label: 'Configuration',
    items: [
      { href: '/admin/dashboard/form-settings', label: 'Form Settings', icon: Settings },
      { href: '/admin/dashboard/site-setting', label: 'Site Settings', icon: Settings },
    ],
  },
];

export function AdminConsoleLayout({ children }: PropsWithChildren) {
  const pathname = usePathname();
  const router = useRouter();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [sessionReady] = useState(() => (typeof window !== 'undefined' ? Boolean(localStorage.getItem(ADMIN_TOKEN_KEY)) : false));

  useEffect(() => {
    if (!sessionReady) {
      router.replace('/admin/login');
    }
  }, [router, sessionReady]);

  const toggleSidebar = () => setIsSidebarCollapsed(!isSidebarCollapsed);

  const activeItem = useMemo(
    () => NAV_GROUPS.flatMap((group) => group.items).find((item) => pathname === item.href),
    [pathname],
  );

  const logout = () => {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    router.push('/admin/login');
  };

  if (!sessionReady) {
    return <div className="min-h-screen bg-slate-100" />;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 via-slate-50 to-sky-50 text-slate-900">
      <div className="flex min-h-screen">
        {isMobileMenuOpen && <button className="fixed inset-0 z-30 bg-slate-950/40 lg:hidden" onClick={() => setIsMobileMenuOpen(false)} aria-label="Close menu" />}

        <aside
          className={`fixed inset-y-0 left-0 z-40 bg-gradient-to-b from-[#022f52] to-[#064073] text-slate-100 transition-all duration-300 ease-in-out lg:static ${
            isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
          } ${isSidebarCollapsed ? 'w-20' : 'w-72'} lg:translate-x-0`}
        >
          <div className="flex h-full flex-col">
            <div className="border-b border-sky-900/40 px-4 py-5">
              {!isSidebarCollapsed ? (
                <>
                  <p className="text-lg font-extrabold tracking-wide bg-gradient-to-r from-sky-200 to-white bg-clip-text text-transparent">CITIZEN Admin</p>
                  <p className="text-xs uppercase tracking-[0.26em] text-sky-300">Control Center</p>
                </>
              ) : (
                <p className="text-center text-xl font-extrabold text-sky-200">C</p>
              )}
            </div>

            <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-6">
              {NAV_GROUPS.map((group) => (
                <div key={group.label} className="space-y-2">
                  {!isSidebarCollapsed && (
                    <p className="px-2 text-xs font-bold uppercase tracking-[0.24em] text-sky-300">{group.label}</p>
                  )}
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const isActive = pathname === item.href;

                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition-all duration-200 ${
                          isActive
                            ? 'bg-gradient-to-r from-sky-500/20 to-sky-400/20 text-white shadow-lg shadow-sky-500/25'
                            : 'text-sky-100/90 hover:bg-sky-100/10'
                        }`}
                        onClick={() => setIsMobileMenuOpen(false)}
                        title={isSidebarCollapsed ? item.label : undefined}
                      >
                        <Icon className="h-5 w-5 flex-shrink-0" />
                        {!isSidebarCollapsed && <span className="truncate">{item.label}</span>}
                      </Link>
                    );
                  })}
                </div>
              ))}
            </nav>

            <div className="border-t border-sky-900/40 p-3">
              {!isSidebarCollapsed ? (
                <>
                  <Link
                    href="/admin/dashboard/form-settings"
                    className={`mb-2 flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition ${
                      pathname === '/admin/dashboard/form-settings' ? 'bg-sky-200 text-[#022f52]' : 'bg-sky-900/50 text-sky-100'
                    }`}
                    onClick={() => setIsMobileMenuOpen(false)}
                  >
                    <Settings className="h-4 w-4" /> Form Settings
                  </Link>
                  <p className="text-xs text-sky-300/70">Last synced 5 min ago</p>
                </>
              ) : (
                <Link
                  href="/admin/dashboard/form-settings"
                  className={`mb-2 flex items-center justify-center rounded-xl px-3 py-2 text-sm font-semibold transition ${
                    pathname === '/admin/dashboard/form-settings' ? 'bg-sky-200 text-[#022f52]' : 'bg-sky-900/50 text-sky-100'
                  }`}
                  onClick={() => setIsMobileMenuOpen(false)}
                  title="Form Settings"
                >
                  <Settings className="h-4 w-4" />
                </Link>
              )}
            </div>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="border-b border-slate-200 bg-white/80 backdrop-blur-md shadow-sm">
            <div className="flex items-center justify-between gap-3 px-4 py-4 lg:px-8">
              <div className="flex items-center gap-3">
                <button
                  className="hidden rounded-xl border border-slate-300 bg-white p-2 text-slate-700 shadow-sm transition hover:bg-slate-50 lg:block"
                  onClick={toggleSidebar}
                  aria-label="Toggle sidebar"
                >
                  {isSidebarCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
                </button>
                <button className="rounded-xl border border-slate-300 bg-white p-2 text-slate-700 shadow-sm lg:hidden" onClick={() => setIsMobileMenuOpen(true)} aria-label="Open menu">
                  <Menu className="h-4 w-4" />
                </button>
                <div>
                  <h1 className="text-2xl font-extrabold bg-gradient-to-r from-slate-800 to-slate-600 bg-clip-text text-transparent">CITIZEN Admin Control</h1>
                  <p className="text-sm font-semibold text-slate-500">Monitor your network operations in real time.</p>
                </div>
              </div>

              <div className="flex items-center gap-4">
                <div className="hidden text-right md:block">
                  <p className="font-bold text-slate-900">Admin</p>
                  <p className="text-sm text-slate-500">Administrator access</p>
                </div>
                <div className="grid h-10 w-10 place-items-center rounded-full bg-gradient-to-br from-[#02507f] to-[#022f52] text-white shadow-lg shadow-blue-900/30">
                  <CircleUserRound className="h-5 w-5" />
                </div>
                <button
                  className="hidden sm:inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2 font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
                  onClick={logout}
                >
                  <LogOut className="h-4 w-4" /> Sign out
                </button>
              </div>
            </div>
          </header>

          <main className="flex-1 px-4 py-6 lg:px-8">
            <div className="mb-6 flex items-center justify-between">
              <h2 className="text-4xl font-black bg-gradient-to-r from-slate-900 to-slate-700 bg-clip-text text-transparent">{activeItem?.label ?? 'Dashboard'}</h2>
              <span className="rounded-full bg-gradient-to-r from-[#061941] to-[#022f52] px-5 py-1.5 text-sm font-extrabold tracking-[0.2em] text-white shadow-lg shadow-blue-900/20">ADMIN</span>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white/80 p-4 shadow-xl backdrop-blur-sm lg:p-6">{children}</div>
          </main>
        </div>
      </div>
    </div>
  );
}
