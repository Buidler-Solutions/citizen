/* eslint-disable @next/next/no-img-element */
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { OnboardingNetworkBackground } from '@/components/OnboardingNetworkBackground';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

const toAbsoluteUrl = (url: string) => {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }
  if (url.startsWith('/')) {
    return `${API_URL}${url}`;
  }
  return `${API_URL}/${url}`;
};

const navItems = [
  { label: 'Onboarding', href: '#onboarding' },
  { label: 'Validators', href: '#validators' },
  { label: 'Builders', href: '#builders' },
  { label: 'Docs', href: '#docs' },
];

export default function MainPage() {
  const [siteLogoUrl, setSiteLogoUrl] = useState('');
  const [siteLogoAlt, setSiteLogoAlt] = useState('Citizen');
  const [siteName, setSiteName] = useState('Citizen');

  useEffect(() => {
    const loadSiteSettings = async () => {
      try {
        const response = await fetch(`${API_URL}/interest/form-settings`);

        if (!response.ok) {
          return;
        }

        const settingsData = (await response.json()) as {
          siteLogoUrl?: string;
          siteLogoAlt?: string;
          siteName?: string;
        };

        if (settingsData.siteLogoUrl) {
          setSiteLogoUrl(toAbsoluteUrl(settingsData.siteLogoUrl));
        }
        if (settingsData.siteLogoAlt?.trim()) {
          setSiteLogoAlt(settingsData.siteLogoAlt.trim());
        }
        if (settingsData.siteName?.trim()) {
          setSiteName(settingsData.siteName.trim());
        }
      } catch {
        // fallback to default branding
      }
    };

    void loadSiteSettings();
  }, []);

  return (
    <>
      <OnboardingNetworkBackground />
      <main className="relative z-10 min-h-screen w-full px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
        <header className="pointer-events-auto fixed left-4 right-4 top-4 z-30 rounded-[28px] border border-slate-200/10 bg-slate-950/10 px-4 py-2.5 backdrop-blur-md sm:left-6 sm:right-6 sm:top-6 sm:rounded-full sm:px-5 sm:py-3 lg:left-10 lg:right-10">
          <div className="mx-auto flex w-full max-w-[1240px] items-center justify-between gap-5">
            <Link href="/" className="flex min-w-0 items-center gap-2 md:gap-3" aria-label={siteLogoAlt}>
              {siteLogoUrl ? (
                <span className="shrink-0">
                  <img src={siteLogoUrl} alt={siteLogoAlt} className="h-[58px] w-[97px] object-contain" />
                </span>
              ) : (
                <span className="text-[0.68rem] font-semibold uppercase tracking-[0.22em] text-slate-100 sm:text-sm sm:tracking-[0.2em]">Citizen</span>
              )}
              {siteLogoUrl ? (
                <span className="block max-w-[calc(100vw-12rem)] truncate whitespace-nowrap text-xs font-semibold tracking-[0.16em] text-slate-100/90 sm:text-sm">
                  {siteName}
                </span>
              ) : null}
            </Link>

            <nav aria-label="Primary" className="hidden md:block">
              <ul className="m-0 flex list-none items-center gap-6 p-0 text-sm font-medium text-slate-200">
                {navItems.map((item) => (
                  <li key={item.label}>
                    <a href={item.href} className="transition-colors hover:text-cyan-300">
                      {item.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>

            <Link
              href="/onboarding"
              className="rounded-full border border-cyan-300/40 px-4 py-1.5 text-xs font-semibold tracking-[0.08em] text-cyan-200 transition-colors hover:border-cyan-200 hover:text-cyan-100"
            >
              Start onboarding
            </Link>
          </div>
        </header>

        <div className="mx-auto grid w-full max-w-[1240px] gap-8 pb-16 pt-28 sm:pt-32 lg:gap-10">
          <section
            id="onboarding"
            className="rounded-3xl border border-slate-100/10 bg-slate-950/35 p-8 shadow-[0_30px_100px_rgba(2,8,30,0.5)] backdrop-blur-md sm:p-10"
          >
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">Onboarding</p>
            <h1 className="mt-4 max-w-3xl text-4xl font-semibold leading-tight text-slate-50 sm:text-5xl">
              Governance-first onboarding for teams joining {siteName}.
            </h1>
            <p className="mt-6 max-w-3xl text-lg text-slate-200/85">
              The main page follows the onboarding visual style and keeps a clear path into the full onboarding flow.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/onboarding"
                className="inline-flex rounded-full bg-cyan-400 px-6 py-3 text-sm font-semibold text-slate-950 transition-colors hover:bg-cyan-300"
              >
                Go to onboarding page
              </Link>
              <a
                href="#validators"
                className="inline-flex rounded-full border border-cyan-300/40 px-6 py-3 text-sm font-semibold text-cyan-100 transition-colors hover:border-cyan-200 hover:text-cyan-50"
              >
                Explore sections
              </a>
            </div>
          </section>

          <section id="validators" className="rounded-3xl border border-slate-100/10 bg-slate-950/30 p-8 backdrop-blur-md sm:p-10">
            <h2 className="text-3xl font-semibold text-slate-50">Validators</h2>
            <p className="mt-4 max-w-3xl text-slate-200/80">
              Describe validator operations, namespace policy enforcement, and how governance readiness gates participation for production deployments.
            </p>
          </section>

          <section id="builders" className="rounded-3xl border border-slate-100/10 bg-slate-950/30 p-8 backdrop-blur-md sm:p-10">
            <h2 className="text-3xl font-semibold text-slate-50">Builders</h2>
            <p className="mt-4 max-w-3xl text-slate-200/80">
              Show how builder teams use the SDK, API layer, and local-stack workflows to ship deterministic, policy-aware applications.
            </p>
          </section>

          <section id="docs" className="rounded-3xl border border-slate-100/10 bg-slate-950/30 p-8 backdrop-blur-md sm:p-10">
            <h2 className="text-3xl font-semibold text-slate-50">Docs</h2>
            <p className="mt-4 max-w-3xl text-slate-200/80">
              Link architecture baselines, runbooks, readiness reviews, and implementation guides used by operators and integrators.
            </p>
          </section>
        </div>
      </main>
    </>
  );
}
