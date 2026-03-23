'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Mail, Send, Settings2, ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { ADMIN_TOKEN_KEY } from '@/components/admin-auth';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Textarea } from '@/components/admin-ui';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

type AudienceMode = 'all' | 'role' | 'selected';

interface SmtpSettingsResponse {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromAddress: string;
  replyTo: string;
  defaultBcc: string;
  rejectUnauthorized: boolean;
  resolvedSource?: string;
}

interface TemplateListItem {
  type: string;
  subject: string;
  html: string;
  placeholders: string[];
}

interface TemplateDetails extends TemplateListItem {
  source: 'default' | 'database';
}

interface AudienceRecipient {
  id: string;
  email: string;
  fullName: string;
  institution: string;
  role: string;
}

const EMPTY_SMTP: SmtpSettingsResponse = {
  host: '',
  port: 587,
  secure: false,
  username: '',
  password: '',
  fromAddress: '',
  replyTo: '',
  defaultBcc: '',
  rejectUnauthorized: true,
};

export default function EmailCenterPage() {
  const router = useRouter();
  const [smtp, setSmtp] = useState<SmtpSettingsResponse>(EMPTY_SMTP);
  const [templates, setTemplates] = useState<TemplateListItem[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState('forgotPassword');
  const [templateDetails, setTemplateDetails] = useState<TemplateDetails | null>(null);
  const [testRecipient, setTestRecipient] = useState('');
  const [audienceMode, setAudienceMode] = useState<AudienceMode>('all');
  const [audienceRole, setAudienceRole] = useState('builder');
  const [audienceSearch, setAudienceSearch] = useState('');
  const [customSubject, setCustomSubject] = useState('');
  const [messageHtml, setMessageHtml] = useState('<p>We are reviewing the next onboarding cohort and will share timelines soon.</p>');
  const [audiencePreview, setAudiencePreview] = useState<AudienceRecipient[]>([]);
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewSubject, setPreviewSubject] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingSmtp, setSavingSmtp] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [sendingUpdate, setSendingUpdate] = useState(false);
  const [testingSmtp, setTestingSmtp] = useState(false);

  const token = typeof window !== 'undefined' ? localStorage.getItem(ADMIN_TOKEN_KEY) : null;

  useEffect(() => {
    if (!token) {
      router.replace('/admin/login');
      return;
    }

    const load = async () => {
      try {
        const [smtpResponse, templatesResponse] = await Promise.all([
          fetch(`${API_URL}/admin/email/smtp-settings`, { headers: { Authorization: `Bearer ${token}` } }),
          fetch(`${API_URL}/admin/email/templates`, { headers: { Authorization: `Bearer ${token}` } }),
        ]);

        if (smtpResponse.status === 401 || templatesResponse.status === 401) {
          localStorage.removeItem(ADMIN_TOKEN_KEY);
          router.replace('/admin/login');
          return;
        }

        if (!smtpResponse.ok || !templatesResponse.ok) {
          throw new Error('Unable to load email center configuration.');
        }

        const smtpData = (await smtpResponse.json()) as Partial<SmtpSettingsResponse>;
        setSmtp((previous) => ({ ...previous, ...smtpData }));
        const templateList = (await templatesResponse.json()) as TemplateListItem[];
        setTemplates(templateList);
        const firstTemplate = templateList[0]?.type ?? 'forgotPassword';
        setSelectedTemplate(firstTemplate);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Unknown email center error');
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [router, token]);

  useEffect(() => {
    if (!token || !selectedTemplate) {
      return;
    }

    const loadTemplate = async () => {
      try {
        const response = await fetch(`${API_URL}/admin/email/templates/${encodeURIComponent(selectedTemplate)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (response.status === 401) {
          localStorage.removeItem(ADMIN_TOKEN_KEY);
          router.replace('/admin/login');
          return;
        }

        if (!response.ok) {
          throw new Error('Unable to load template.');
        }

        setTemplateDetails((await response.json()) as TemplateDetails);
      } catch (templateError) {
        setError(templateError instanceof Error ? templateError.message : 'Unable to load template');
      }
    };

    void loadTemplate();
  }, [router, selectedTemplate, token]);

  const audiencePayload = useMemo(() => ({
    audienceMode,
    role: audienceMode === 'role' ? audienceRole : undefined,
    search: audienceSearch || undefined,
    messageHtml,
    customSubject: customSubject || undefined,
  }), [audienceMode, audienceRole, audienceSearch, customSubject, messageHtml]);

  const saveSmtp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token) return;

    setSavingSmtp(true);
    setStatus('Saving SMTP settings...');
    setError('');
    try {
      const response = await fetch(`${API_URL}/admin/email/smtp-settings`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(smtp),
      });

      if (!response.ok) {
        throw new Error('Unable to save SMTP settings.');
      }

      setStatus('SMTP settings saved.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save SMTP settings.');
      setStatus('');
    } finally {
      setSavingSmtp(false);
    }
  };

  const sendTest = async () => {
    if (!token || !testRecipient.trim()) return;
    setTestingSmtp(true);
    setStatus('Sending SMTP test...');
    setError('');

    try {
      const response = await fetch(`${API_URL}/admin/email/smtp-settings/test`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: testRecipient.trim() }),
      });

      if (!response.ok) {
        throw new Error('Unable to send SMTP test.');
      }

      setStatus('SMTP test request completed.');
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : 'SMTP test failed');
      setStatus('');
    } finally {
      setTestingSmtp(false);
    }
  };

  const saveTemplate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token || !templateDetails) return;

    setSavingTemplate(true);
    setStatus(`Saving ${selectedTemplate} template...`);
    setError('');

    try {
      const response = await fetch(`${API_URL}/admin/email/templates/${encodeURIComponent(selectedTemplate)}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: templateDetails.subject, html: templateDetails.html }),
      });

      if (!response.ok) {
        throw new Error('Unable to save template.');
      }

      setTemplateDetails((await response.json()) as TemplateDetails);
      setStatus(`Template ${selectedTemplate} saved.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save template');
      setStatus('');
    } finally {
      setSavingTemplate(false);
    }
  };

  const resetTemplate = async () => {
    if (!token) return;
    setStatus(`Resetting ${selectedTemplate} template...`);
    setError('');
    try {
      const response = await fetch(`${API_URL}/admin/email/templates/${encodeURIComponent(selectedTemplate)}/reset`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        throw new Error('Unable to reset template.');
      }

      setTemplateDetails((await response.json()) as TemplateDetails);
      setStatus(`Template ${selectedTemplate} reset to defaults.`);
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : 'Unable to reset template');
      setStatus('');
    }
  };

  const previewAudience = async () => {
    if (!token) return;
    setPreviewing(true);
    setError('');
    setStatus('Loading onboarding update preview...');

    try {
      const response = await fetch(`${API_URL}/admin/email/onboarding-updates/preview`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(audiencePayload),
      });

      if (!response.ok) {
        throw new Error('Unable to preview onboarding update.');
      }

      const payload = (await response.json()) as { recipients: AudienceRecipient[]; preview: { subject: string; html: string } | null };
      setAudiencePreview(payload.recipients);
      setPreviewSubject(payload.preview?.subject ?? '');
      setPreviewHtml(payload.preview?.html ?? '');
      setStatus(`Loaded preview for ${payload.recipients.length} recipient(s).`);
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : 'Unable to preview onboarding update');
      setStatus('');
    } finally {
      setPreviewing(false);
    }
  };

  const sendUpdate = async () => {
    if (!token) return;
    setSendingUpdate(true);
    setError('');
    setStatus('Sending onboarding update...');
    try {
      const response = await fetch(`${API_URL}/admin/email/onboarding-updates/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(audiencePayload),
      });

      if (!response.ok) {
        throw new Error('Unable to send onboarding update.');
      }

      const payload = (await response.json()) as { totalRecipients: number; sent: number };
      setStatus(`Onboarding update attempted for ${payload.totalRecipients} recipient(s); ${payload.sent} sent.`);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'Unable to send onboarding update');
      setStatus('');
    } finally {
      setSendingUpdate(false);
    }
  };

  if (loading) {
    return <div className="py-8 text-sm text-slate-500">Loading email center…</div>;
  }

  return (
    <section className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        <Card gradient>
          <CardContent className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">SMTP source</p>
              <p className="mt-2 text-2xl font-bold text-slate-900">{smtp.resolvedSource ?? 'database'}</p>
            </div>
            <Settings2 className="h-10 w-10 text-indigo-600" />
          </CardContent>
        </Card>
        <Card gradient>
          <CardContent className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Templates</p>
              <p className="mt-2 text-2xl font-bold text-slate-900">{templates.length}</p>
            </div>
            <Mail className="h-10 w-10 text-blue-600" />
          </CardContent>
        </Card>
        <Card gradient>
          <CardContent className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Update audience</p>
              <p className="mt-2 text-2xl font-bold text-slate-900">{audiencePreview.length}</p>
            </div>
            <Send className="h-10 w-10 text-emerald-600" />
          </CardContent>
        </Card>
      </div>

      {status && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700">{status}</div>}
      {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{error}</div>}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>SMTP settings</CardTitle>
            <CardDescription>Configure the active onboarding email relay and send a test message.</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={saveSmtp}>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2"><Label htmlFor="host">Host</Label><Input id="host" value={smtp.host} onChange={(event) => setSmtp((prev) => ({ ...prev, host: event.target.value }))} /></div>
                <div className="space-y-2"><Label htmlFor="port">Port</Label><Input id="port" type="number" value={String(smtp.port)} onChange={(event) => setSmtp((prev) => ({ ...prev, port: Number(event.target.value) || 0 }))} /></div>
                <div className="space-y-2"><Label htmlFor="username">Username</Label><Input id="username" value={smtp.username} onChange={(event) => setSmtp((prev) => ({ ...prev, username: event.target.value }))} /></div>
                <div className="space-y-2"><Label htmlFor="password">Password</Label><Input id="password" type="password" value={smtp.password} onChange={(event) => setSmtp((prev) => ({ ...prev, password: event.target.value }))} /></div>
                <div className="space-y-2"><Label htmlFor="fromAddress">From address</Label><Input id="fromAddress" value={smtp.fromAddress} onChange={(event) => setSmtp((prev) => ({ ...prev, fromAddress: event.target.value }))} /></div>
                <div className="space-y-2"><Label htmlFor="replyTo">Reply-to</Label><Input id="replyTo" value={smtp.replyTo} onChange={(event) => setSmtp((prev) => ({ ...prev, replyTo: event.target.value }))} /></div>
              </div>
              <div className="space-y-2"><Label htmlFor="defaultBcc">Default BCC</Label><Input id="defaultBcc" value={smtp.defaultBcc} onChange={(event) => setSmtp((prev) => ({ ...prev, defaultBcc: event.target.value }))} placeholder="ops@example.com; audit@example.com" /></div>
              <div className="flex flex-wrap gap-4 text-sm text-slate-600">
                <label className="inline-flex items-center gap-2"><input type="checkbox" checked={smtp.secure} onChange={(event) => setSmtp((prev) => ({ ...prev, secure: event.target.checked }))} /> Secure (TLS)</label>
                <label className="inline-flex items-center gap-2"><input type="checkbox" checked={smtp.rejectUnauthorized} onChange={(event) => setSmtp((prev) => ({ ...prev, rejectUnauthorized: event.target.checked }))} /> Reject unauthorized certificates</label>
              </div>
              <div className="flex flex-wrap gap-3">
                <Button type="submit" disabled={savingSmtp}>{savingSmtp ? 'Saving…' : 'Save SMTP settings'}</Button>
                <Input value={testRecipient} onChange={(event) => setTestRecipient(event.target.value)} placeholder="test recipient email" className="max-w-xs" />
                <Button type="button" variant="secondary" onClick={sendTest} disabled={testingSmtp || !testRecipient.trim()}>{testingSmtp ? 'Sending…' : 'Send test'}</Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle>Email templates</CardTitle>
                <CardDescription>Edit database overrides for onboarding email templates.</CardDescription>
              </div>
              {templateDetails && <Badge variant={templateDetails.source === 'database' ? 'success' : 'default'}>{templateDetails.source}</Badge>}
            </div>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={saveTemplate}>
              <div className="space-y-2">
                <Label htmlFor="templateType">Template type</Label>
                <select id="templateType" className="w-full rounded-xl border-2 border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 outline-none transition focus:border-blue-400" value={selectedTemplate} onChange={(event) => setSelectedTemplate(event.target.value)}>
                  {templates.map((template) => <option key={template.type} value={template.type}>{template.type}</option>)}
                </select>
              </div>
              <div className="space-y-2"><Label htmlFor="templateSubject">Subject</Label><Input id="templateSubject" value={templateDetails?.subject ?? ''} onChange={(event) => setTemplateDetails((prev) => prev ? { ...prev, subject: event.target.value } : prev)} /></div>
              <div className="space-y-2"><Label htmlFor="templateHtml">HTML body</Label><Textarea id="templateHtml" rows={14} value={templateDetails?.html ?? ''} onChange={(event) => setTemplateDetails((prev) => prev ? { ...prev, html: event.target.value } : prev)} /></div>
              <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-600">
                <p className="font-semibold text-slate-900">Available placeholders</p>
                <p className="mt-2">{templateDetails?.placeholders.join(', ') || '—'}</p>
              </div>
              <div className="flex flex-wrap gap-3">
                <Button type="submit" disabled={savingTemplate || !templateDetails}>{savingTemplate ? 'Saving…' : 'Save template'}</Button>
                <Button type="button" variant="secondary" onClick={resetTemplate} disabled={!templateDetails}>Reset to default</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="rounded-2xl bg-blue-100 p-3 text-blue-700"><ShieldCheck className="h-5 w-5" /></div>
            <div>
              <CardTitle>Onboarding update composer</CardTitle>
              <CardDescription>Preview and send status updates to applicants in bulk or by role.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="audienceMode">Audience mode</Label>
              <select id="audienceMode" className="w-full rounded-xl border-2 border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 outline-none transition focus:border-blue-400" value={audienceMode} onChange={(event) => setAudienceMode(event.target.value as AudienceMode)}>
                <option value="all">All applicants</option>
                <option value="role">By role</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="audienceRole">Role</Label>
              <Input id="audienceRole" value={audienceRole} onChange={(event) => setAudienceRole(event.target.value)} disabled={audienceMode !== 'role'} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="audienceSearch">Search filter</Label>
              <Input id="audienceSearch" value={audienceSearch} onChange={(event) => setAudienceSearch(event.target.value)} placeholder="name, email, institution" />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="customSubject">Custom subject override</Label>
            <Input id="customSubject" value={customSubject} onChange={(event) => setCustomSubject(event.target.value)} placeholder="Optional custom subject" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="messageHtml">Update message (HTML allowed)</Label>
            <Textarea id="messageHtml" rows={8} value={messageHtml} onChange={(event) => setMessageHtml(event.target.value)} />
          </div>
          <div className="flex flex-wrap gap-3">
            <Button type="button" onClick={previewAudience} disabled={previewing}>{previewing ? 'Previewing…' : 'Preview audience'}</Button>
            <Button type="button" variant="secondary" onClick={sendUpdate} disabled={sendingUpdate || audiencePreview.length === 0}>{sendingUpdate ? 'Sending…' : 'Send update'}</Button>
          </div>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <div className="rounded-2xl border border-slate-200 p-4">
              <p className="mb-3 font-semibold text-slate-900">Audience preview</p>
              <div className="space-y-3 text-sm text-slate-600">
                {audiencePreview.length === 0 ? <p>No recipients loaded yet.</p> : audiencePreview.map((recipient) => (
                  <div key={recipient.id} className="rounded-xl bg-slate-50 p-3">
                    <p className="font-semibold text-slate-900">{recipient.fullName}</p>
                    <p>{recipient.email}</p>
                    <p>{recipient.role} · {recipient.institution}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200 p-4">
              <p className="mb-1 font-semibold text-slate-900">Rendered preview</p>
              <p className="mb-4 text-sm text-slate-500">Subject: {previewSubject || 'Not loaded yet'}</p>
              <div className="prose max-w-none rounded-xl bg-slate-50 p-4" dangerouslySetInnerHTML={{ __html: previewHtml || '<p>No preview loaded yet.</p>' }} />
            </div>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
