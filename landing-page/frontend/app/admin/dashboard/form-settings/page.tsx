'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Save, FileText, Palette, LoaderCircle, Check, ListChecks, Plus, Trash2, X } from 'lucide-react';
import { Button, Input, Label, Textarea } from '@/components/admin-ui';
import { ADMIN_TOKEN_KEY } from '@/components/admin-auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface RoleOption {
  id: string;
  label: string;
  prompt: string;
  thankYouNote: string;
  weight: number;
}

interface FormSettingsResponse {
  title: string;
  subtitle: string;
  roles: RoleOption[];
  asciinemaCastUrl: string;
  asciinemaShortcode: string;
}

type FormSettingsPayload = Pick<FormSettingsResponse, 'title' | 'subtitle' | 'roles' | 'asciinemaShortcode'>;

const DEFAULT_ROLES: RoleOption[] = [
  {
    id: 'validator',
    label: 'Validator',
    prompt: 'I want to stress test system as a Validator focused on...',
    thankYouNote: 'Thank you for applying to run a Citizen Validator node. We have added you to the validator waitlist. Our team will review your submission and send onboarding updates, eligibility checks, and timeline details to your email.',
    weight: 1,
  },
  {
    id: 'builder',
    label: 'Builder',
    prompt: 'I want to build civic applications as a Builder for...',
    thankYouNote: 'Thank you for joining as a Builder. You are now on our builder waitlist. We will share product updates, API access details, and onboarding milestones by email as new slots open.',
    weight: 2,
  },
  {
    id: 'observer',
    label: 'Observer',
    prompt: 'I want to run audits as an Observer to improve...',
    thankYouNote: 'Thank you for registering as an Observer. We have added you to the observer waitlist. You will receive updates by email about review status, audit participation windows, and next steps.',
    weight: 3,
  },
];

const DEFAULT_SETTINGS: FormSettingsResponse = {
  title: 'Build Public Truth with Citizen',
  subtitle: 'Validator · Builder · Observer onboarding',
  roles: DEFAULT_ROLES,
  asciinemaCastUrl: '',
  asciinemaShortcode: 'onboarding-demo',
};

export default function FormSettingsPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState('basic');
  const [settings, setSettings] = useState<FormSettingsResponse>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saveStatus, setSaveStatus] = useState('');
  const [formColor, setFormColor] = useState('#022f52');
  const [isAddRoleModalOpen, setIsAddRoleModalOpen] = useState(false);
  const [newRoleDraft, setNewRoleDraft] = useState<RoleOption>({
    id: '',
    label: '',
    prompt: 'I want to contribute to Citizen Protocol by...',
    thankYouNote: 'Thank you for your interest. We have received your submission and will share the next onboarding updates by email.',
    weight: 1,
  });
  const [addRoleError, setAddRoleError] = useState('');
  const [castFile, setCastFile] = useState<File | null>(null);
  const [uploadingCast, setUploadingCast] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem(ADMIN_TOKEN_KEY);

    if (!token) {
      router.replace('/admin/login');
      return;
    }

    const loadSettings = async () => {
      try {
        const response = await fetch(`${API_URL}/interest/form-settings`);

        if (response.status === 401) {
          localStorage.removeItem(ADMIN_TOKEN_KEY);
          router.replace('/admin/login');
          return;
        }

        if (response.ok) {
          const settingsData = (await response.json()) as Partial<FormSettingsResponse>;
          setSettings((prev) => ({
            ...prev,
            title: settingsData.title ?? prev.title,
            subtitle: settingsData.subtitle ?? prev.subtitle,
            roles: Array.isArray(settingsData.roles) && settingsData.roles.length > 0
              ? settingsData.roles
              : prev.roles,
            asciinemaCastUrl: settingsData.asciinemaCastUrl ?? prev.asciinemaCastUrl,
            asciinemaShortcode: settingsData.asciinemaShortcode ?? prev.asciinemaShortcode,
          }));
        }
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    };

    loadSettings();
  }, [router]);

  const sanitizeRoleId = (value: string) => value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  const saveSettings = async () => {
    const token = localStorage.getItem(ADMIN_TOKEN_KEY);

    if (!token) {
      router.replace('/admin/login');
      return;
    }

    try {
      setSaving(true);
      setSaveStatus('Saving...');
      const payload: FormSettingsPayload = {
        title: settings.title,
        subtitle: settings.subtitle,
        roles: settings.roles.map((role, index) => ({
          ...role,
          id: sanitizeRoleId(role.id || role.label || `role-${index + 1}`),
          weight: index + 1,
        })),
        asciinemaShortcode: settings.asciinemaShortcode.trim(),
      };

      const response = await fetch(`${API_URL}/interest/form-settings`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (response.status === 401) {
        localStorage.removeItem(ADMIN_TOKEN_KEY);
        router.replace('/admin/login');
        return;
      }

      if (!response.ok) {
        const details = await response.text();
        throw new Error(details || 'Unable to save form settings');
      }

      setSaveStatus('Settings saved successfully!');
    } catch (saveError) {
      setSaveStatus(saveError instanceof Error ? saveError.message : 'Unknown error');
    } finally {
      setSaving(false);
    }
  };

  const uploadCastFile = async () => {
    const token = localStorage.getItem(ADMIN_TOKEN_KEY);

    if (!token) {
      router.replace('/admin/login');
      return;
    }

    if (!castFile) {
      setSaveStatus('Please choose a .cast file before uploading.');
      return;
    }

    const formData = new FormData();
    formData.append('castFile', castFile);

    try {
      setUploadingCast(true);
      setSaveStatus('Uploading cast file...');

      const response = await fetch(`${API_URL}/interest/form-settings/asciinema-upload`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      });

      if (response.status === 401) {
        localStorage.removeItem(ADMIN_TOKEN_KEY);
        router.replace('/admin/login');
        return;
      }

      if (!response.ok) {
        const details = await response.text();
        throw new Error(details || 'Unable to upload cast file.');
      }

      const updated = (await response.json()) as Partial<FormSettingsResponse>;
      if (updated.asciinemaCastUrl) {
        setSettings((prev) => ({ ...prev, asciinemaCastUrl: updated.asciinemaCastUrl ?? prev.asciinemaCastUrl }));
      }
      setCastFile(null);
      setSaveStatus('Cast file uploaded successfully!');
    } catch (uploadError) {
      setSaveStatus(uploadError instanceof Error ? uploadError.message : 'Unknown error');
    } finally {
      setUploadingCast(false);
    }
  };

  const openAddRoleModal = () => {
    const nextIndex = settings.roles.length + 1;
    setNewRoleDraft({
      id: `role-${nextIndex}`,
      label: `Role ${nextIndex}`,
      prompt: 'I want to contribute to Citizen Protocol by...',
      thankYouNote: 'Thank you for your interest. We have received your submission and will share the next onboarding updates by email.',
      weight: nextIndex,
    });
    setAddRoleError('');
    setIsAddRoleModalOpen(true);
  };

  const closeAddRoleModal = () => {
    setIsAddRoleModalOpen(false);
    setAddRoleError('');
  };

  const addRoleFromModal = () => {
    const label = newRoleDraft.label.trim();
    const sanitizedId = sanitizeRoleId(newRoleDraft.id || label || `role-${settings.roles.length + 1}`);

    if (label.length < 2) {
      setAddRoleError('Role label must be at least 2 characters.');
      return;
    }

    if (newRoleDraft.prompt.trim().length < 5) {
      setAddRoleError('Role prompt must be at least 5 characters.');
      return;
    }

    if (newRoleDraft.thankYouNote.trim().length < 20) {
      setAddRoleError('Thank you note must be at least 20 characters.');
      return;
    }

    if (!sanitizedId) {
      setAddRoleError('Role ID is required.');
      return;
    }

    if (settings.roles.some((role) => role.id === sanitizedId)) {
      setAddRoleError('Role ID already exists. Please use a unique ID.');
      return;
    }

    setSettings((prev) => ({
      ...prev,
      roles: [
        ...prev.roles,
        {
          ...newRoleDraft,
          id: sanitizedId,
          label,
          prompt: newRoleDraft.prompt.trim(),
          thankYouNote: newRoleDraft.thankYouNote.trim(),
          weight: prev.roles.length + 1,
        },
      ],
    }));

    closeAddRoleModal();
  };

  const updateRole = (index: number, updates: Partial<RoleOption>) => {
    setSettings((prev) => ({
      ...prev,
      roles: prev.roles.map((role, roleIndex) => (roleIndex === index ? { ...role, ...updates } : role)),
    }));
  };

  const removeRole = (index: number) => {
    setSettings((prev) => ({
      ...prev,
      roles: prev.roles.filter((_, roleIndex) => roleIndex !== index),
    }));
  };

  const tabs = [
    { id: 'basic', label: 'Basic Info', icon: FileText },
    { id: 'roles', label: 'Role Options', icon: ListChecks },
    { id: 'appearance', label: 'Appearance', icon: Palette },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <LoaderCircle className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border-2 border-red-200 bg-red-50 p-4 text-sm font-medium text-red-600">{error}</div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">Form Settings</h2>
          <p className="text-slate-600">Configure onboarding form content and behavior</p>
        </div>
        <div className="flex items-center gap-3">
          {saveStatus && (
            <div className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold ${
              saveStatus.includes('success') ? 'bg-emerald-50 text-emerald-700' : 'bg-blue-50 text-blue-700'
            }`}>
              <Check className="h-4 w-4" />
              {saveStatus}
            </div>
          )}
          <Button
            onClick={saveSettings}
            disabled={saving}
            isLoading={saving}
            className="gap-2"
          >
            <Save className="h-4 w-4" />
            Save Changes
          </Button>
        </div>
      </div>

      <div className="space-y-8">
        <div className="flex gap-2 overflow-x-auto">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 whitespace-nowrap rounded-xl px-6 py-3 text-sm font-bold transition-all duration-200 ${
                  activeTab === tab.id
                    ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-lg shadow-blue-500/30'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </div>

        <div className="space-y-8 py-8">
          {activeTab === 'basic' && (
            <div className="space-y-8">
              <div>
                <h3 className="text-lg font-bold text-slate-900">Basic Information</h3>
                <p className="text-sm text-slate-600">Configure basic form settings</p>
              </div>

              <div className="grid gap-6 md:grid-cols-2">
                <Input
                  label="Form Title"
                  value={settings.title}
                  onChange={(e) => setSettings((prev) => ({ ...prev, title: e.target.value }))}
                />
                <Input
                  label="Form Subtitle"
                  value={settings.subtitle}
                  onChange={(e) => setSettings((prev) => ({ ...prev, subtitle: e.target.value }))}
                />
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-5">
                <h4 className="text-sm font-bold uppercase tracking-wide text-slate-700">Asciinema Recording</h4>
                <p className="mt-1 text-sm text-slate-600">Upload a .cast (or JSON cast) file and publish it for the onboarding modal.</p>
                <div className="mt-4 max-w-md">
                  <Input
                    label="Shortcode"
                    value={settings.asciinemaShortcode}
                    onChange={(event) => setSettings((prev) => ({ ...prev, asciinemaShortcode: event.target.value }))}
                    placeholder="onboarding-demo"
                  />
                  <p className="mt-1 text-xs text-slate-500">Use this in content as: [asciinema:{settings.asciinemaShortcode || 'onboarding-demo'}] or [asciinema:{settings.asciinemaShortcode || 'onboarding-demo'}|Custom label]</p>
                </div>
                {settings.asciinemaCastUrl && (
                  <p className="mt-2 text-xs text-emerald-700">Current file: {settings.asciinemaCastUrl}</p>
                )}
                <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
                  <Input
                    type="file"
                    accept=".cast,application/json"
                    onChange={(event) => setCastFile(event.target.files?.[0] ?? null)}
                    className="sm:max-w-md"
                  />
                  <Button onClick={uploadCastFile} disabled={!castFile || uploadingCast} isLoading={uploadingCast}>
                    Upload Cast
                  </Button>
                </div>
              </div>
            </div>
          )}



          {activeTab === 'roles' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h3 className="text-lg font-bold text-slate-900">Role Options</h3>
                  <p className="text-sm text-slate-600">Control onboarding role choices dynamically from admin settings</p>
                </div>
                <Button onClick={openAddRoleModal} className="gap-2">
                  <Plus className="h-4 w-4" /> Add Role
                </Button>
              </div>

              <div className="space-y-6">
                {settings.roles.map((role, index) => (
                  <div key={`${role.id}-${index}`} className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5">
                    <div className="grid gap-4 md:grid-cols-[1fr_1fr_auto]">
                      <Input
                        label="Role Label"
                        value={role.label}
                        onChange={(event) => {
                          const label = event.target.value;
                          updateRole(index, { label, id: sanitizeRoleId(label) || role.id });
                        }}
                      />
                      <Input
                        label="Role ID"
                        value={role.id}
                        onChange={(event) => updateRole(index, { id: sanitizeRoleId(event.target.value) })}
                      />
                      <div className="flex items-end">
                        <Button
                          onClick={() => removeRole(index)}
                          variant="outline"
                          className="gap-2"
                          disabled={settings.roles.length <= 1}
                        >
                          <Trash2 className="h-4 w-4" /> Remove
                        </Button>
                      </div>
                    </div>

                    <Textarea
                      label="Prompt"
                      value={role.prompt}
                      onChange={(event) => updateRole(index, { prompt: event.target.value })}
                      rows={4}
                    />
                    <Textarea
                      label="Thank You Note"
                      value={role.thankYouNote}
                      onChange={(event) => updateRole(index, { thankYouNote: event.target.value })}
                      rows={5}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'appearance' && (
            <div className="space-y-8">
              <div>
                <h3 className="text-lg font-bold text-slate-900">Appearance Settings</h3>
                <p className="text-sm text-slate-600">Customize visual appearance of form</p>
              </div>

              <div className="rounded-2xl bg-gradient-to-br from-slate-50 to-white p-8 shadow-lg shadow-slate-200/50">
                <Label className="text-base font-semibold">Primary Color</Label>
                <div className="mt-4 flex items-center gap-6">
                  <div
                    className="h-24 w-24 rounded-2xl shadow-xl transition-all duration-300"
                    style={{ backgroundColor: formColor }}
                  />
                  <div className="flex-1">
                    <Input
                      type="color"
                      value={formColor}
                      onChange={(e) => setFormColor(e.target.value)}
                      className="h-12 w-40"
                    />
                    <p className="mt-2 text-sm text-slate-600">Choose the primary accent color for your form</p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {isAddRoleModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-2xl">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-bold text-slate-900">Add New Role</h3>
                <p className="text-sm text-slate-600">Create a new onboarding role option for the landing page form.</p>
              </div>
              <button
                type="button"
                onClick={closeAddRoleModal}
                className="rounded-lg border border-slate-200 p-2 text-slate-500 transition hover:bg-slate-100"
                aria-label="Close add role modal"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4">
              <Input
                label="Role Label"
                value={newRoleDraft.label}
                onChange={(event) => {
                  const label = event.target.value;
                  setNewRoleDraft((prev) => ({
                    ...prev,
                    label,
                    id: sanitizeRoleId(label) || prev.id,
                  }));
                }}
              />
              <Input
                label="Role ID"
                value={newRoleDraft.id}
                onChange={(event) => setNewRoleDraft((prev) => ({
                  ...prev,
                  id: sanitizeRoleId(event.target.value),
                }))}
              />
              <Textarea
                label="Prompt"
                value={newRoleDraft.prompt}
                onChange={(event) => setNewRoleDraft((prev) => ({
                  ...prev,
                  prompt: event.target.value,
                }))}
                rows={4}
              />
              <Textarea
                label="Thank You Note"
                value={newRoleDraft.thankYouNote}
                onChange={(event) => setNewRoleDraft((prev) => ({
                  ...prev,
                  thankYouNote: event.target.value,
                }))}
                rows={5}
              />

              {addRoleError && (
                <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-600">{addRoleError}</p>
              )}
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <Button variant="outline" onClick={closeAddRoleModal}>Cancel</Button>
              <Button onClick={addRoleFromModal} className="gap-2">
                <Plus className="h-4 w-4" /> Add Role
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
