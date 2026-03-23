'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { ShieldCheck, UserCog, UserPlus, Users } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { ADMIN_TOKEN_KEY, getAdminSession, type AdminSession } from './admin-auth';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from './admin-ui';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

type ManagedUserRole = 'super_admin' | 'admin' | 'user';

interface ManagedUser {
  id: string;
  username: string;
  email: string;
  fullName: string;
  role: ManagedUserRole;
  isActive: boolean;
  createdAt: string;
}

interface CreateUserFormState {
  fullName: string;
  username: string;
  email: string;
  password: string;
  role: 'admin' | 'user';
}

const EMPTY_FORM: CreateUserFormState = {
  fullName: '',
  username: '',
  email: '',
  password: '',
  role: 'admin',
};

function formatRole(role: ManagedUserRole) {
  return role.split('_').map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1)).join(' ');
}

export function AdminUsersPage() {
  const router = useRouter();
  const [session, setSession] = useState<AdminSession | null>(null);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [form, setForm] = useState<CreateUserFormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    const token = localStorage.getItem(ADMIN_TOKEN_KEY);

    if (!token) {
      router.replace('/admin/login');
      return;
    }

    const activeSession = getAdminSession();

    if (!activeSession) {
      localStorage.removeItem(ADMIN_TOKEN_KEY);
      router.replace('/admin/login');
      return;
    }

    setSession(activeSession);

    const loadUsers = async () => {
      try {
        const response = await fetch(`${API_URL}/users`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (response.status === 401) {
          localStorage.removeItem(ADMIN_TOKEN_KEY);
          router.replace('/admin/login');
          return;
        }

        if (!response.ok) {
          throw new Error('Unable to load onboarding users.');
        }

        setUsers((await response.json()) as ManagedUser[]);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Unknown user loading error');
      } finally {
        setLoading(false);
      }
    };

    loadUsers();
  }, [router]);

  const counts = useMemo(() => ({
    total: users.length,
    admins: users.filter((user) => user.role === 'admin').length,
    normalUsers: users.filter((user) => user.role === 'user').length,
  }), [users]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const token = localStorage.getItem(ADMIN_TOKEN_KEY);

    if (!token) {
      router.replace('/admin/login');
      return;
    }

    setError('');
    setSuccess('');
    setSaving(true);

    try {
      const response = await fetch(`${API_URL}/users`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fullName: form.fullName,
          username: form.username,
          email: form.email,
          password: form.password,
          role: form.role,
        }),
      });

      if (response.status === 401) {
        localStorage.removeItem(ADMIN_TOKEN_KEY);
        router.replace('/admin/login');
        return;
      }

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { message?: string | string[] } | null;
        const message = Array.isArray(payload?.message)
          ? payload?.message.join(', ')
          : payload?.message ?? 'Unable to create user.';
        throw new Error(message);
      }

      const createdUser = (await response.json()) as ManagedUser;
      setUsers((previous) => [...previous, createdUser]);
      setForm(EMPTY_FORM);
      setSuccess(`${formatRole(createdUser.role)} ${createdUser.username} created successfully.`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Unknown user creation error');
    } finally {
      setSaving(false);
    }
  };

  const canManageUsers = session?.role === 'super_admin';

  return (
    <section className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        <Card gradient>
          <CardContent className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Onboarding users</p>
              <p className="mt-2 text-3xl font-bold text-slate-900">{counts.total}</p>
            </div>
            <Users className="h-10 w-10 text-blue-600" />
          </CardContent>
        </Card>
        <Card gradient>
          <CardContent className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Admins</p>
              <p className="mt-2 text-3xl font-bold text-slate-900">{counts.admins}</p>
            </div>
            <UserCog className="h-10 w-10 text-indigo-600" />
          </CardContent>
        </Card>
        <Card gradient>
          <CardContent className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Normal users</p>
              <p className="mt-2 text-3xl font-bold text-slate-900">{counts.normalUsers}</p>
            </div>
            <ShieldCheck className="h-10 w-10 text-emerald-600" />
          </CardContent>
        </Card>
      </div>

      {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{error}</div>}
      {success && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700">{success}</div>}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(340px,0.8fr)]">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle>Existing onboarding users</CardTitle>
                <CardDescription>Super admins can add admin and normal user accounts for the landing-page onboarding console.</CardDescription>
              </div>
              {session && <Badge variant={canManageUsers ? 'success' : 'default'}>{formatRole(session.role)}</Badge>}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {loading ? (
              <p className="text-sm text-slate-500">Loading onboarding users…</p>
            ) : (
              <div className="overflow-hidden rounded-2xl border border-slate-200">
                <div className="grid grid-cols-[1.1fr_1.1fr_1fr_0.8fr_0.8fr] gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-bold uppercase tracking-wider text-slate-500">
                  <span>User</span>
                  <span>Email</span>
                  <span>Name</span>
                  <span>Role</span>
                  <span>Status</span>
                </div>
                <div className="divide-y divide-slate-200">
                  {users.map((user) => (
                    <div key={user.id} className="grid grid-cols-[1.1fr_1.1fr_1fr_0.8fr_0.8fr] gap-3 px-4 py-4 text-sm text-slate-700">
                      <div>
                        <p className="font-semibold text-slate-900">{user.username}</p>
                        <p className="text-xs text-slate-500">Created {new Date(user.createdAt).toLocaleDateString()}</p>
                      </div>
                      <span className="break-all">{user.email || '—'}</span>
                      <span>{user.fullName || '—'}</span>
                      <span>{formatRole(user.role)}</span>
                      <span>{user.isActive ? 'Active' : 'Disabled'}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="rounded-2xl bg-blue-100 p-3 text-blue-700">
                <UserPlus className="h-5 w-5" />
              </div>
              <div>
                <CardTitle>Add onboarding user</CardTitle>
                <CardDescription>Create new admin or normal user accounts.</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {canManageUsers ? (
              <form className="space-y-4" onSubmit={submit}>
                <div className="space-y-2">
                  <Label htmlFor="fullName">Full name</Label>
                  <Input id="fullName" value={form.fullName} onChange={(event) => setForm((previous) => ({ ...previous, fullName: event.target.value }))} placeholder="Jane Citizen" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="username">Username</Label>
                  <Input id="username" value={form.username} onChange={(event) => setForm((previous) => ({ ...previous, username: event.target.value }))} placeholder="jane.admin" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" value={form.email} onChange={(event) => setForm((previous) => ({ ...previous, email: event.target.value }))} placeholder="jane.admin@example.gov" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">Temporary password</Label>
                  <Input id="password" type="password" value={form.password} onChange={(event) => setForm((previous) => ({ ...previous, password: event.target.value }))} placeholder="Minimum 8 characters" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="role">Role</Label>
                  <select
                    id="role"
                    value={form.role}
                    onChange={(event) => setForm((previous) => ({ ...previous, role: event.target.value as CreateUserFormState['role'] }))}
                    className="w-full rounded-xl border-2 border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 outline-none transition focus:border-blue-400"
                  >
                    <option value="admin">Admin</option>
                    <option value="user">User</option>
                  </select>
                </div>
                <Button type="submit" disabled={saving}>{saving ? 'Creating…' : 'Create user'}</Button>
              </form>
            ) : (
              <p className="text-sm text-slate-500">Only the seeded or promoted super admin can create onboarding users.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
