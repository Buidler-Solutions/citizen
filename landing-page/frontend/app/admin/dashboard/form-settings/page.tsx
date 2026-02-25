'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Save, FileText, Palette, LoaderCircle, Check } from 'lucide-react';
import { Button, Input, Label, Textarea } from '@/components/admin-ui';
import { ADMIN_TOKEN_KEY } from '@/components/admin-auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface FormSettingsResponse {
  title: string;
  subtitle: string;
  validatorPrompt: string;
  builderPrompt: string;
  observerPrompt: string;
}

type FormSettingsPayload = Pick<
  FormSettingsResponse,
  'title' | 'subtitle' | 'validatorPrompt' | 'builderPrompt' | 'observerPrompt'
>;

const DEFAULT_SETTINGS: FormSettingsResponse = {
  title: 'Build Public Truth with Citizen',
  subtitle: 'Validator · Builder · Observer onboarding',
  validatorPrompt: 'I want to stress test system as a Validator focused on...',
  builderPrompt: 'I want to build civic applications as a Builder for...',
  observerPrompt: 'I want to run audits as an Observer to improve...',
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
            validatorPrompt: settingsData.validatorPrompt ?? prev.validatorPrompt,
            builderPrompt: settingsData.builderPrompt ?? prev.builderPrompt,
            observerPrompt: settingsData.observerPrompt ?? prev.observerPrompt,
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
        validatorPrompt: settings.validatorPrompt,
        builderPrompt: settings.builderPrompt,
        observerPrompt: settings.observerPrompt,
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

  const tabs = [
    { id: 'basic', label: 'Basic Info', icon: FileText },
    { id: 'prompts', label: 'Role Prompts', icon: FileText },
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
    <div className="space-y-10">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">Form Settings</h2>
          <p className="text-sm text-slate-600">Configure the interest form displayed on your landing page</p>
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
        <div className="flex overflow-x-auto gap-2">
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
            </div>
          )}

          {activeTab === 'prompts' && (
            <div className="space-y-8">
              <div>
                <h3 className="text-lg font-bold text-slate-900">Role Prompts</h3>
                <p className="text-sm text-slate-600">Configure prompts for different user roles</p>
              </div>

              <div className="space-y-6">
                <div>
                  <Textarea
                    label="Validator Prompt"
                    value={settings.validatorPrompt}
                    onChange={(e) => setSettings((prev) => ({ ...prev, validatorPrompt: e.target.value }))}
                    rows={4}
                  />
                  <p className="mt-2 text-sm text-slate-600">Prompt for validator role selection</p>
                </div>

                <div>
                  <Textarea
                    label="Builder Prompt"
                    value={settings.builderPrompt}
                    onChange={(e) => setSettings((prev) => ({ ...prev, builderPrompt: e.target.value }))}
                    rows={4}
                  />
                  <p className="mt-2 text-sm text-slate-600">Prompt for builder role selection</p>
                </div>

                <div>
                  <Textarea
                    label="Observer Prompt"
                    value={settings.observerPrompt}
                    onChange={(e) => setSettings((prev) => ({ ...prev, observerPrompt: e.target.value }))}
                    rows={4}
                  />
                  <p className="mt-2 text-sm text-slate-600">Prompt for observer role selection</p>
                </div>
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
    </div>
  );
}
