'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, LoaderCircle, LogOut, Mail, Settings2, Users } from 'lucide-react';
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

export function AdminDashboard() {
  const router = useRouter();
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [submissions, setSubmissions] = useState<InterestSubmission[]>([]);
  const [error, setError] = useState('');
  const [saveStatus, setSaveStatus] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [settings, setSettings] = useState<FormSettingsResponse>(DEFAULT_SETTINGS);

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
    <section className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <Badge variant="secondary">Admin Console</Badge>
          <h1 className="text-3xl font-semibold tracking-tight">Landing Page Dashboard</h1>
          <p className="text-sm text-muted-foreground">Manage submissions and edit onboarding prompts using a builder-friendly workflow.</p>
        </div>
        <Button type="button" variant="outline" onClick={logout}>
          <LogOut className="mr-2 h-4 w-4" /> Sign out
        </Button>
      </div>

      {error && (
        <Card className="border-red-400/60 bg-red-900/10">
          <CardContent className="pt-6 text-sm text-red-200">{error}</CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4" /> Interest submissions
            </CardTitle>
            <CardDescription>Authenticated live count from backend stats endpoint.</CardDescription>
          </CardHeader>
          <CardContent>
            {!error && !stats ? (
              <p className="text-sm text-muted-foreground">Loading stats...</p>
            ) : (
              <p className="text-4xl font-bold">{stats?.totalInterestSubmissions ?? 0}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Settings2 className="h-4 w-4" /> Prompt health
            </CardTitle>
            <CardDescription>Tracks how many role prompts are currently configured.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Completion</span>
              <span className="font-medium">{completion}%</span>
            </div>
            <Progress value={completion} />
            <p className="text-xs text-muted-foreground">Keep all role prompts explicit to improve onboarding quality.</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Latest submissions</CardTitle>
          <CardDescription>Review incoming interest requests and contact prospects directly over email.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {submissions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No submissions yet.</p>
          ) : (
            submissions.map((submission) => (
              <div key={submission.id} className="rounded-lg border border-border/70 bg-background/40 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">{submission.fullName}</p>
                    <p className="text-sm text-muted-foreground">
                      {submission.institution} · {submission.country}
                    </p>
                  </div>
                  <Button asChild variant="outline" size="sm">
                    <a href={`mailto:${submission.email}?subject=${encodeURIComponent('Citizen Protocol onboarding')}`}>
                      <Mail className="mr-2 h-4 w-4" /> Email
                    </a>
                  </Button>
                </div>
                <p className="mt-3 text-sm text-muted-foreground">{submission.email}</p>
                <p className="mt-2 text-sm leading-relaxed">{submission.missionNeed}</p>
                <p className="mt-3 text-xs text-muted-foreground">
                  Submitted {new Date(submission.createdAt).toLocaleString()}
                </p>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Form settings</CardTitle>
          <CardDescription>These values drive the public landing page experience in real time.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-5" onSubmit={saveSettings}>
            <div className="grid gap-2">
              <Label htmlFor="title">Form title</Label>
              <Input id="title" value={settings.title} onChange={(event) => setSettings((prev) => ({ ...prev, title: event.target.value }))} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="subtitle">Form subtitle</Label>
              <Input id="subtitle" value={settings.subtitle} onChange={(event) => setSettings((prev) => ({ ...prev, subtitle: event.target.value }))} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="validatorPrompt">Validator prompt</Label>
              <Textarea id="validatorPrompt" rows={3} value={settings.validatorPrompt} onChange={(event) => setSettings((prev) => ({ ...prev, validatorPrompt: event.target.value }))} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="builderPrompt">Builder prompt</Label>
              <Textarea id="builderPrompt" rows={3} value={settings.builderPrompt} onChange={(event) => setSettings((prev) => ({ ...prev, builderPrompt: event.target.value }))} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="observerPrompt">Observer prompt</Label>
              <Textarea id="observerPrompt" rows={3} value={settings.observerPrompt} onChange={(event) => setSettings((prev) => ({ ...prev, observerPrompt: event.target.value }))} />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={isSaving}>
                {isSaving ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                Save form settings
              </Button>
              {saveStatus && <p className="text-sm text-muted-foreground">{saveStatus}</p>}
            </div>
          </form>
        </CardContent>
      </Card>
    </section>
  );
}
