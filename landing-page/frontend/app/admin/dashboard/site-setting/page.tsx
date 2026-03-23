/* eslint-disable @next/next/no-img-element */
'use client';

import { ChangeEvent, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ImagePlus, LoaderCircle, UploadCloud } from 'lucide-react';
import { Button, Input, Label } from '@/components/admin-ui';
import { ADMIN_TOKEN_KEY } from '@/components/admin-auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const REQUIRED_LOGO_WIDTH = 97;
const REQUIRED_LOGO_HEIGHT = 58;

interface SiteSettingsResponse {
  siteLogoUrl: string;
  siteLogoAlt: string;
  siteName: string;
}

const ACCEPTED_LOGO_FORMATS = '.png,.apng,.jpg,.jpeg,.svg,.webp,image/png,image/apng,image/jpeg,image/svg+xml,image/webp';

const DEFAULT_SETTINGS: SiteSettingsResponse = {
  siteLogoUrl: '',
  siteLogoAlt: 'Citizen',
  siteName: 'Citizen',
};

const toAbsoluteUrl = (url: string) => {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('/')) return `${API_URL}${url}`;
  return `${API_URL}/${url}`;
};

export default function SiteSettingPage() {
  const router = useRouter();
  const [settings, setSettings] = useState<SiteSettingsResponse>(DEFAULT_SETTINGS);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState('');
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [savingSiteName, setSavingSiteName] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const token = localStorage.getItem(ADMIN_TOKEN_KEY);

    if (!token) {
      router.replace('/admin/login');
      return;
    }

    const loadSettings = async () => {
      try {
        const response = await fetch(`${API_URL}/interest/form-settings`);

        if (!response.ok) {
          throw new Error('Unable to load site settings.');
        }

        const data = (await response.json()) as Partial<SiteSettingsResponse>;
        setSettings({
          siteLogoUrl: data.siteLogoUrl ?? '',
          siteLogoAlt: data.siteLogoAlt ?? 'Citizen',
          siteName: data.siteName ?? 'Citizen',
        });
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Unknown load error.');
      } finally {
        setLoading(false);
      }
    };

    void loadSettings();
  }, [router]);

  useEffect(() => {
    if (!logoFile) {
      setLogoPreview('');
      return undefined;
    }

    const objectUrl = URL.createObjectURL(logoFile);
    setLogoPreview(objectUrl);

    return () => URL.revokeObjectURL(objectUrl);
  }, [logoFile]);

  const currentLogoUrl = useMemo(() => logoPreview || toAbsoluteUrl(settings.siteLogoUrl), [logoPreview, settings.siteLogoUrl]);

  const saveSiteName = async () => {
    const token = localStorage.getItem(ADMIN_TOKEN_KEY);

    if (!token) {
      router.replace('/admin/login');
      return;
    }

    try {
      setSavingSiteName(true);
      setError('');
      setStatus('Saving site name...');

      const response = await fetch(`${API_URL}/interest/form-settings`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ siteName: settings.siteName.trim() || 'Citizen' }),
      });

      if (response.status === 401) {
        localStorage.removeItem(ADMIN_TOKEN_KEY);
        router.replace('/admin/login');
        return;
      }

      if (!response.ok) {
        const details = await response.text();
        throw new Error(details || 'Unable to save site name.');
      }

      const updatedSettings = (await response.json()) as Partial<SiteSettingsResponse>;
      setSettings((prev) => ({
        ...prev,
        siteName: updatedSettings.siteName ?? prev.siteName,
      }));
      setStatus('Site name saved successfully.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unknown save error.');
      setStatus('');
    } finally {
      setSavingSiteName(false);
    }
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setStatus('');
    setError('');

    if (!file) {
      setLogoFile(null);
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      if (image.naturalWidth !== REQUIRED_LOGO_WIDTH || image.naturalHeight !== REQUIRED_LOGO_HEIGHT) {
        setLogoFile(null);
        setError(`Logo must be exactly ${REQUIRED_LOGO_WIDTH} × ${REQUIRED_LOGO_HEIGHT} px.`);
        URL.revokeObjectURL(objectUrl);
        event.target.value = '';
        return;
      }

      setLogoFile(file);
      URL.revokeObjectURL(objectUrl);
    };

    image.onerror = () => {
      setLogoFile(null);
      setError('Unable to read the selected image.');
      URL.revokeObjectURL(objectUrl);
      event.target.value = '';
    };

    image.src = objectUrl;
  };

  const uploadLogo = async () => {
    const token = localStorage.getItem(ADMIN_TOKEN_KEY);

    if (!token) {
      router.replace('/admin/login');
      return;
    }

    if (!logoFile) {
      setError('Choose a logo file before uploading.');
      return;
    }

    try {
      setUploading(true);
      setError('');
      setStatus('Uploading site logo...');
      const formData = new FormData();
      formData.append('logoFile', logoFile);
      formData.append('altText', settings.siteLogoAlt.trim() || 'Citizen');

      const response = await fetch(`${API_URL}/interest/site-logo/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      if (response.status === 401) {
        localStorage.removeItem(ADMIN_TOKEN_KEY);
        router.replace('/admin/login');
        return;
      }

      if (!response.ok) {
        const details = await response.text();
        throw new Error(details || 'Unable to upload site logo.');
      }

      const updatedSettings = (await response.json()) as Partial<SiteSettingsResponse>;
      setSettings({
        siteLogoUrl: updatedSettings.siteLogoUrl ?? '',
        siteLogoAlt: updatedSettings.siteLogoAlt ?? settings.siteLogoAlt,
        siteName: updatedSettings.siteName ?? settings.siteName,
      });
      setLogoFile(null);
      setStatus('Site logo uploaded successfully. The landing page header now uses the new branding.');
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Unknown upload error.');
      setStatus('');
    } finally {
      setUploading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <LoaderCircle className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <section className="space-y-6">
      <div className="rounded-3xl border border-slate-200 bg-gradient-to-br from-white to-slate-50 p-6 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="space-y-2">
            <div className="inline-flex rounded-2xl bg-sky-100 p-3 text-sky-700">
              <ImagePlus className="h-6 w-6" />
            </div>
            <div>
              <h3 className="text-2xl font-bold text-slate-900">Site logo settings</h3>
              <p className="mt-1 text-sm text-slate-600">Upload the logo used in the landing page header from the admin console.</p>
            </div>
          </div>
          <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
            Required landing-page logo size: <span className="font-semibold">97 × 58 px</span>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="siteName">Site name</Label>
              <Input
                id="siteName"
                value={settings.siteName}
                onChange={(event) => setSettings((prev) => ({ ...prev, siteName: event.target.value }))}
                placeholder="Citizen"
              />
              <p className="text-sm text-slate-500">This label appears inline beside the landing-page logo.</p>
              <Button onClick={saveSiteName} disabled={savingSiteName} isLoading={savingSiteName}>
                Save site name
              </Button>
            </div>

            <div className="space-y-2">
              <Label htmlFor="siteLogoAlt">Logo alt text</Label>
              <Input
                id="siteLogoAlt"
                value={settings.siteLogoAlt}
                onChange={(event) => setSettings((prev) => ({ ...prev, siteLogoAlt: event.target.value }))}
                placeholder="Citizen"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="siteLogoFile">Upload logo file</Label>
              <Input
                id="siteLogoFile"
                type="file"
                accept={ACCEPTED_LOGO_FORMATS}
                onChange={onFileChange}
              />
              <p className="text-sm text-slate-500">Accepted formats: PNG, APNG, JPG, SVG, WEBP. Animated APNG logos remain animated on the landing page. Max file size: 2 MB.</p>
            </div>

            <Button onClick={uploadLogo} disabled={!logoFile || uploading} isLoading={uploading} className="gap-2">
              {uploading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
              Upload site logo
            </Button>

            {status ? <p className="text-sm font-medium text-emerald-600">{status}</p> : null}
            {error ? <p className="text-sm font-medium text-rose-600">{error}</p> : null}
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-slate-50 p-6 shadow-sm">
          <div className="space-y-4">
            <div>
              <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">Header preview</p>
              <p className="mt-1 text-sm text-slate-600">Preview of the exact 97 × 58 px logo container used on the landing page.</p>
            </div>

            <div className="rounded-[28px] border border-slate-800 bg-slate-950 p-5">
              <div className="flex items-center justify-between gap-6">
                <div className="flex h-[58px] w-[97px] items-center justify-center overflow-hidden rounded-xl bg-white/5">
                  {currentLogoUrl ? (
                    <img src={currentLogoUrl} alt={settings.siteLogoAlt || 'Citizen'} className="h-[58px] w-[97px] object-contain" />
                  ) : (
                    <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-300">Citizen</span>
                  )}
                </div>
                <span className="hidden text-sm font-semibold tracking-[0.18em] text-slate-200 md:inline-block">
                  {settings.siteName || 'Citizen'}
                </span>
                <div className="hidden flex-1 justify-end gap-4 text-sm text-slate-400 md:flex">
                  <span>Onboarding</span>
                  <span>Validators</span>
                  <span>Builders</span>
                  <span>Docs</span>
                </div>
              </div>
            </div>

            {settings.siteLogoUrl ? (
              <p className="text-xs text-slate-500">Current stored logo: {settings.siteLogoUrl}</p>
            ) : (
              <p className="text-xs text-slate-500">No logo uploaded yet. The landing page will continue to show the Citizen text mark until a file is uploaded.</p>
            )}

            <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-600">
              <p className="font-medium text-slate-900">Tip</p>
              <p className="mt-1">For the best result, upload artwork already prepared to 97 px wide by 58 px high. The landing page preserves the full logo using object-contain, and APNG uploads keep their animation in the header.</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
