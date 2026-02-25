'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CheckCircle2,
  FileText,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Mail,
  PanelLeftClose,
  PanelLeftOpen,
  Settings2,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import { ADMIN_TOKEN_KEY } from './admin-auth';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface StatsResponse {
  totalInterestSubmissions: number;
}

interface InterestSubmission {
  id: string;
  fullName: string;
  institution: string;
  email: string;
  country: string;
  missionNeed: string;
  createdAt: string;
}

interface FormSettingsResponse {
  title: string;
  subtitle: string;
  validatorPrompt: string;
  builderPrompt: string;
  observerPrompt: string;
}

const DEFAULT_SETTINGS: FormSettingsResponse = {
  title: 'Build Public Truth with Citizen',
  subtitle: 'Validator · Builder · Observer onboarding',
  validatorPrompt: 'I want to stress test the system as a Validator focused on...',
  builderPrompt: 'I want to build civic applications as a Builder for...',
  observerPrompt: 'I want to run audits as an Observer to improve...',
};

const ROLE_PROMPTS: Array<keyof Pick<FormSettingsResponse, 'validatorPrompt' | 'builderPrompt' | 'observerPrompt'>> = [
  'validatorPrompt',
  'builderPrompt',
  'observerPrompt',
];

const NAV_ITEMS = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'submissions', label: 'Submissions', icon: Users },
  { id: 'form-settings', label: 'Form Settings', icon: FileText },
  { id: 'system', label: 'System', icon: Settings2 },
] as const;

export function AdminDashboard() {
  const router = useRouter();
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [submissions, setSubmissions] = useState<InterestSubmission[]>([]);
  const [error, setError] = useState('');
  const [saveStatus, setSaveStatus] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [settings, setSettings] = useState<FormSettingsResponse>(DEFAULT_SETTINGS);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem(ADMIN_TOKEN_KEY);

    if (!token) {
      router.replace('/admin/login');
      return;
    }

    const loadDashboard = async () => {
      try {
        const [statsResponse, settingsResponse, submissionsResponse] = await Promise.all([
          fetch(`${API_URL}/interest/stats`, { headers: { Authorization: `Bearer ${token}` } }),
          fetch(`${API_URL}/interest/form-settings`),
          fetch(`${API_URL}/interest/submissions`, { headers: { Authorization: `Bearer ${token}` } }),
        ]);

        if (statsResponse.status === 401 || submissionsResponse.status === 401) {
          localStorage.removeItem(ADMIN_TOKEN_KEY);
          router.replace('/admin/login');
          return;
        }

        if (!statsResponse.ok) {
          throw new Error('Unable to load admin stats');
        }

        const statsData = (await statsResponse.json()) as StatsResponse;
        setStats(statsData);

        if (settingsResponse.ok) {
          const settingsData = (await settingsResponse.json()) as Partial<FormSettingsResponse>;
          setSettings((prev) => ({ ...prev, ...settingsData }));
        }

        if (submissionsResponse.ok) {
          const submissionsData = (await submissionsResponse.json()) as InterestSubmission[];
          setSubmissions(submissionsData);
        }
      } catch (statsError) {
        setError(statsError instanceof Error ? statsError.message : 'Unknown dashboard error');
      }
    };

    loadDashboard();
  }, [router]);

  const completion = useMemo(() => {
    const filled = ROLE_PROMPTS.filter((field) => settings[field].trim().length > 0).length;
    return Math.round((filled / ROLE_PROMPTS.length) * 100);
  }, [settings]);

  const scrollToSection = (sectionId: string) => {
    document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setIsMobileSidebarOpen(false);
  };

  const logout = () => {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    router.push('/admin/login');
  };

  const saveSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const token = localStorage.getItem(ADMIN_TOKEN_KEY);

    if (!token) {
      router.replace('/admin/login');
      return;
    }

    try {
      setIsSaving(true);
      setSaveStatus('Saving form settings...');
      const response = await fetch(`${API_URL}/interest/form-settings`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(settings),
      });

      if (response.status === 401) {
        localStorage.removeItem(ADMIN_TOKEN_KEY);
        router.replace('/admin/login');
        return;
      }

      if (!response.ok) {
        throw new Error('Unable to save form settings');
      }

      setSaveStatus('Form settings saved. Landing page will use the new prompts.');
    } catch (saveError) {
      setSaveStatus(saveError instanceof Error ? saveError.message : 'Unknown save error');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="relative mx-auto flex w-full max-w-7xl gap-4 overflow-hidden px-4 py-6 md:gap-6 md:py-8">
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_10%_8%,hsl(var(--primary)/0.18),transparent_24%),radial-gradient(circle_at_90%_4%,hsl(var(--primary)/0.1),transparent_28%)]" />

      {isMobileSidebarOpen && <div className="fixed inset-0 z-20 bg-black/50 backdrop-blur-sm lg:hidden" onClick={() => setIsMobileSidebarOpen(false)} />}

      <aside
        className={`fixed inset-y-0 left-0 z-30 w-72 rounded-r-2xl border-r border-border/70 bg-card/95 p-4 shadow-2xl backdrop-blur-md transition-transform duration-300 lg:sticky lg:top-4 lg:z-auto lg:h-[calc(100vh-2rem)] lg:rounded-2xl lg:border lg:shadow-xl lg:shadow-primary/5 ${
          isMobileSidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        } ${isSidebarCollapsed ? 'lg:w-20' : 'lg:w-72'}`}
      >
        <div className="mb-6 flex items-center justify-between gap-2 border-b border-border/60 pb-4">
          {!isSidebarCollapsed && (
            <div>
              <p className="bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-sm font-semibold text-transparent">Citizen Admin</p>
              <p className="text-xs text-muted-foreground">Dashboard navigation</p>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="icon" className="rounded-xl border border-border/60 lg:hidden" onClick={() => setIsMobileSidebarOpen(false)}>
              <X className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setIsSidebarCollapsed((prev) => !prev)}
              aria-label={isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className="hidden rounded-xl border border-border/60 lg:inline-flex"
            >
              {isSidebarCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        <nav className="grid gap-2">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <Button
                key={item.id}
                type="button"
                variant={item.id === 'overview' ? 'secondary' : 'ghost'}
                className="h-10 justify-start gap-2 rounded-xl text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                onClick={() => scrollToSection(item.id)}
              >
                <Icon className="h-4 w-4" />
                {!isSidebarCollapsed && <span>{item.label}</span>}
              </Button>
            );
          })}
        </nav>

        <div className="mt-auto rounded-xl border border-border/70 bg-gradient-to-br from-muted/60 to-muted/10 p-3">
          {!isSidebarCollapsed ? (
            <>
              <p className="text-xs font-semibold">Prompt completion</p>
              <p className="mb-2 text-xs text-muted-foreground">Maintain role prompt quality.</p>
              <Progress value={completion} />
              <p className="mt-2 text-right text-xs font-semibold text-primary">{completion}%</p>
            </>
          ) : (
            <p className="text-center text-xs font-semibold text-primary">{completion}%</p>
          )}
        </div>
      </aside>

      <main className="grid min-w-0 flex-1 gap-6 lg:pl-0">
        <div className="flex items-center justify-between rounded-2xl border border-border/80 bg-card/90 p-3 shadow-sm lg:hidden">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <p className="text-sm font-semibold">Admin Dashboard</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => setIsMobileSidebarOpen(true)} className="gap-2 rounded-lg">
            <PanelLeftOpen className="h-4 w-4" /> Menu
          </Button>
        </div>

        <div id="overview" className="rounded-2xl border border-border/80 bg-gradient-to-br from-background via-background to-muted/40 p-6 shadow-sm md:p-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-3">
              <Badge variant="secondary" className="w-fit rounded-full px-3 py-1">
                Admin Console
              </Badge>
              <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Landing Page Dashboard</h1>
              <p className="max-w-2xl text-sm text-muted-foreground">
                High-end Tailwind styling with a functional sidebar, smooth layout hierarchy, and clean admin ergonomics.
              </p>
            </div>
            <Button type="button" variant="outline" onClick={logout} className="rounded-xl border-border/70 bg-background/80 shadow-sm">
              <LogOut className="mr-2 h-4 w-4" /> Sign out
            </Button>
          </div>
        </div>

        {error && (
          <Card className="border-red-400/60 bg-red-500/5 shadow-sm">
            <CardContent className="pt-6 text-sm text-red-500 dark:text-red-300">{error}</CardContent>
          </Card>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <Card className="group overflow-hidden border-border/70 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md">
            <div className="h-1 w-full bg-gradient-to-r from-cyan-500 to-sky-500" />
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Users className="h-4 w-4 text-cyan-500" /> Interest submissions
              </CardTitle>
              <CardDescription>Authenticated live count from backend stats endpoint.</CardDescription>
            </CardHeader>
            <CardContent>
              {!error && !stats ? <p className="text-sm text-muted-foreground">Loading stats...</p> : <p className="text-5xl font-bold tracking-tight">{stats?.totalInterestSubmissions ?? 0}</p>}
            </CardContent>
          </Card>

          <Card className="group overflow-hidden border-border/70 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md">
            <div className="h-1 w-full bg-gradient-to-r from-violet-500 to-fuchsia-500" />
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Settings2 className="h-4 w-4 text-violet-500" /> Prompt health
              </CardTitle>
              <CardDescription>Tracks how many role prompts are currently configured.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Completion</span>
                <span className="font-semibold text-primary">{completion}%</span>
              </div>
              <Progress value={completion} />
              <p className="text-xs text-muted-foreground">Keep all role prompts explicit to improve onboarding quality.</p>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-5 xl:grid-cols-[1.2fr_1fr]">
          <Card id="submissions" className="border-border/70 shadow-sm scroll-mt-6">
            <CardHeader>
              <CardTitle>Latest submissions</CardTitle>
              <CardDescription>Review incoming interest requests and contact prospects directly over email.</CardDescription>
            </CardHeader>
            <CardContent className="grid max-h-[560px] gap-3 overflow-auto pr-1">
              {submissions.length === 0 ? (
                <p className="text-sm text-muted-foreground">No submissions yet.</p>
              ) : (
                submissions.map((submission) => (
                  <div
                    key={submission.id}
                    className="rounded-xl border border-border/70 bg-card p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:bg-muted/30"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold tracking-tight">{submission.fullName}</p>
                        <p className="text-sm text-muted-foreground">
                          {submission.institution} · {submission.country}
                        </p>
                      </div>
                      <Button asChild variant="outline" size="sm" className="rounded-lg border-border/70">
                        <a href={`mailto:${submission.email}?subject=${encodeURIComponent('Citizen Protocol onboarding')}`}>
                          <Mail className="mr-2 h-4 w-4" /> Email
                        </a>
                      </Button>
                    </div>
                    <p className="mt-3 text-sm text-muted-foreground">{submission.email}</p>
                    <p className="mt-2 text-sm leading-relaxed">{submission.missionNeed}</p>
                    <p className="mt-3 text-xs text-muted-foreground">Submitted {new Date(submission.createdAt).toLocaleString()}</p>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card id="form-settings" className="border-border/70 shadow-sm scroll-mt-6">
            <CardHeader>
              <CardTitle>Form settings</CardTitle>
              <CardDescription>These values drive the public landing page experience in real time.</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="grid gap-5" onSubmit={saveSettings}>
                <div className="grid gap-2">
                  <Label htmlFor="title">Form title</Label>
                  <Input id="title" className="rounded-xl" value={settings.title} onChange={(event) => setSettings((prev) => ({ ...prev, title: event.target.value }))} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="subtitle">Form subtitle</Label>
                  <Input id="subtitle" className="rounded-xl" value={settings.subtitle} onChange={(event) => setSettings((prev) => ({ ...prev, subtitle: event.target.value }))} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="validatorPrompt">Validator prompt</Label>
                  <Textarea
                    id="validatorPrompt"
                    rows={3}
                    className="rounded-xl"
                    value={settings.validatorPrompt}
                    onChange={(event) => setSettings((prev) => ({ ...prev, validatorPrompt: event.target.value }))}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="builderPrompt">Builder prompt</Label>
                  <Textarea
                    id="builderPrompt"
                    rows={3}
                    className="rounded-xl"
                    value={settings.builderPrompt}
                    onChange={(event) => setSettings((prev) => ({ ...prev, builderPrompt: event.target.value }))}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="observerPrompt">Observer prompt</Label>
                  <Textarea
                    id="observerPrompt"
                    rows={3}
                    className="rounded-xl"
                    value={settings.observerPrompt}
                    onChange={(event) => setSettings((prev) => ({ ...prev, observerPrompt: event.target.value }))}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Button type="submit" disabled={isSaving} className="rounded-xl shadow-sm">
                    {isSaving ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                    Save form settings
                  </Button>
                  {saveStatus && <p className="text-sm text-muted-foreground">{saveStatus}</p>}
                </div>
              </form>
            </CardContent>
          </Card>
        </div>

        <Card id="system" className="border-border/70 bg-muted/20 shadow-sm scroll-mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Settings2 className="h-4 w-4 text-primary" /> System
            </CardTitle>
            <CardDescription>Operational summary for admins.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
            <Badge variant="outline" className="rounded-lg border-border/70 px-2 py-1">API: {API_URL}</Badge>
            <span>Authenticated admin session active.</span>
          </CardContent>
        </Card>
      </main>
    </section>
  );
}
