'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { PropsWithChildren, useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  CircleUserRound,
  FileSearch,
  LogOut,
  Menu,
  MessageSquareMore,
  RectangleEllipsis,
  Settings,
  Users,
} from 'lucide-react';
import { ADMIN_TOKEN_KEY, getAdminSession } from './admin-auth';

const NAV_GROUPS = [
  {
    label: 'People',
    items: [
      { href: '/admin/dashboard/users', label: 'Users', icon: Users },
      { href: '/admin/dashboard/applicants', label: 'Submissions', icon: MessageSquareMore },
    ],
  },
  {
    label: 'Configuration',
    items: [
      { href: '/admin/dashboard/form-settings', label: 'Form Settings', icon: Settings },
      { href: '/admin/dashboard/asciinema-storage', label: 'Asciinema Storage', icon: FileSearch },
      { href: '/admin/dashboard/campaign-cards', label: 'Info Cards', icon: RectangleEllipsis },
      { href: '/admin/dashboard/site-setting', label: 'Site Settings', icon: Settings },
    ],
  },
];

function formatRole(role?: string) {
  if (!role) {
    return 'Administrator';
  }

  return role.replace('_', ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

export function AdminConsoleLayout({ children }: PropsWithChildren) {
  const pathname = usePathname();
  const router = useRouter();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const session = useMemo(() => getAdminSession(), []);

  useEffect(() => {
    if (!session) {
      router.replace('/admin/login');
    }
  }, [router, session]);

  const toggleSidebar = () => setIsSidebarCollapsed(!isSidebarCollapsed);

  const activeItem = useMemo(
    () => NAV_GROUPS.flatMap((group) => group.items).find((item) => pathname === item.href),
    [pathname],
  );

  const logout = () => {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    router.push('/admin/login');
  };

  if (!session) {
    return <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50/30 to-indigo-50/20 text-slate-900" />;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50/30 to-indigo-50/20 text-slate-900">
      <div className="flex min-h-screen">
        {isMobileMenuOpen && <button className="fixed inset-0 z-30 bg-slate-950/40 lg:hidden" onClick={() => setIsMobileMenuOpen(false)} aria-label="Close menu" />}

        <aside
          className={`fixed inset-y-0 left-0 z-40 bg-gradient-to-b from-[#0a1929] via-[#0d2847] to-[#103060] text-white transition-all duration-300 ease-in-out lg:static lg:shadow-2xl lg:shadow-black/10 ${isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full'} ${isSidebarCollapsed ? 'w-20' : 'w-72'} lg:translate-x-0`}
        >
          <div className="flex h-full flex-col">
            <div className="px-6 py-8">
              {!isSidebarCollapsed ? (
                <div className="space-y-1">
                  <p className="bg-gradient-to-r from-blue-400 via-sky-300 to-white bg-clip-text text-xl font-bold tracking-tight text-transparent">CITIZEN Admin</p>
                  <p className="text-xs font-medium uppercase tracking-wider text-slate-400">Control Center</p>
                </div>
              ) : (
                <p className="text-center text-2xl font-bold text-blue-400">C</p>
              )}
            </div>

            <nav className="flex-1 space-y-8 overflow-y-auto px-4 py-4">
              {NAV_GROUPS.map((group) => (
                <div key={group.label} className="space-y-3">
                  {!isSidebarCollapsed && (
                    <p className="px-3 text-xs font-bold uppercase tracking-wider text-slate-500">{group.label}</p>
                  )}
                  <div className="space-y-1">
                    {group.items.map((item) => {
                      const Icon = item.icon;
                      const isActive = pathname === item.href;

                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          className={`group relative flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium transition-all duration-200 ${isActive
                            ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-lg shadow-blue-500/30'
                            : 'text-slate-300 hover:bg-white/5 hover:text-white'}`}
                          onClick={() => setIsMobileMenuOpen(false)}
                          title={isSidebarCollapsed ? item.label : undefined}
                        >
                          <Icon className={`h-5 w-5 flex-shrink-0 ${isActive ? 'text-white' : 'text-slate-400 group-hover:text-slate-300'}`} />
                          {!isSidebarCollapsed && <span className="truncate">{item.label}</span>}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}
            </nav>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="bg-white/80 shadow-sm backdrop-blur-xl">
            <div className="flex items-center justify-between gap-3 px-6 py-5 lg:px-8">
              <div className="flex items-center gap-4">
                <button
                  className="hidden rounded-xl bg-slate-100 p-2.5 text-slate-600 transition-all hover:bg-slate-200 hover:text-slate-900 lg:block"
                  onClick={toggleSidebar}
                  aria-label="Toggle sidebar"
                >
                  {isSidebarCollapsed ? <ChevronRight className="h-5 w-5" /> : <ChevronLeft className="h-5 w-5" />}
                </button>
                <button className="rounded-xl bg-slate-100 p-2.5 text-slate-600 transition-all hover:bg-slate-200 hover:text-slate-900 lg:hidden" onClick={() => setIsMobileMenuOpen(true)} aria-label="Open menu">
                  <Menu className="h-5 w-5" />
                </button>
                <div>
                  <h1 className="text-2xl font-bold text-slate-900">CITIZEN Admin Control</h1>
                  <p className="text-sm text-slate-500">Monitor your onboarding and network operations in real time.</p>
                </div>
              </div>

              <div className="flex items-center gap-4">
                <div className="hidden text-right md:block">
                  <p className="font-semibold text-slate-900">{session.username ?? 'Admin'}</p>
                  <p className="text-sm text-slate-500">{formatRole(session.role)} access</p>
                </div>
                <div className="grid h-10 w-10 place-items-center rounded-full bg-gradient-to-br from-blue-600 to-indigo-700 text-white shadow-lg shadow-blue-500/25">
                  <CircleUserRound className="h-5 w-5" />
                </div>
                <button
                  className="hidden items-center gap-2 rounded-xl bg-slate-100 px-4 py-2.5 font-medium text-slate-700 transition-all hover:bg-slate-200 sm:inline-flex"
                  onClick={logout}
                >
                  <LogOut className="h-4 w-4" /> Sign out
                </button>
              </div>
            </div>
          </header>

          <main className="flex-1 px-6 py-8 lg:px-8">
            <div className="mb-8 flex items-center justify-between">
              <h2 className="text-3xl font-bold text-slate-900">{activeItem?.label ?? 'Dashboard'}</h2>
              <span className="rounded-full bg-gradient-to-r from-blue-600 to-indigo-600 px-5 py-2 text-xs font-bold tracking-wider text-white shadow-lg shadow-blue-500/30">{formatRole(session.role)}</span>
            </div>
            <div className="rounded-3xl bg-white p-6 shadow-xl shadow-slate-200/50 lg:p-8">{children}</div>
          </main>
        </div>
      </div>
    </div>
  );
}
