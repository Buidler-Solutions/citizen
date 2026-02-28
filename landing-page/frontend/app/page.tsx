'use client';

import { useState } from 'react';
import { InterestForm } from '@/components/InterestForm';
import { OnboardingNetworkBackground } from '@/components/OnboardingNetworkBackground';

export default function HomePage() {
  const navItems = ['Onboarding', 'Validators', 'Builders', 'Docs'];
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <>
      <OnboardingNetworkBackground />
      <main className="relative z-10 grid min-h-screen w-full grid-rows-[auto_1fr] gap-4 px-4 py-8 sm:px-6 lg:px-10">
        <header className="pointer-events-auto absolute left-4 right-4 top-5 z-20 rounded-[28px] border border-slate-200/10 bg-slate-950/10 px-4 py-2.5 backdrop-blur-md sm:left-6 sm:right-6 sm:top-6 sm:rounded-full sm:px-5 sm:py-3 lg:left-10 lg:right-10">
          <div className="flex items-center justify-between sm:grid sm:items-center sm:gap-4 sm:grid-cols-[1fr_auto_1fr]">
            <a href="#" className="justify-self-start text-[0.68rem] font-semibold uppercase tracking-[0.22em] text-slate-100 sm:text-sm sm:tracking-[0.2em]">
              Citizen
            </a>

            <nav aria-label="Primary" className="justify-self-center">
              <ul className="m-0 hidden list-none items-center gap-6 p-0 text-sm font-medium text-slate-200 sm:flex">
                {navItems.map((item) => (
                  <li key={item}>
                    <a href="#" className="transition-colors hover:text-cyan-300">{item}</a>
                  </li>
                ))}
              </ul>
            </nav>

            <div className="hidden justify-self-end text-right sm:block">
              <button type="button" className="rounded-full border border-cyan-300/40 px-4 py-1.5 text-xs font-semibold tracking-[0.08em] text-cyan-200 transition-colors hover:border-cyan-200 hover:text-cyan-100">
                Login · Guest
              </button>
            </div>

            <details
              className="relative shrink-0 justify-self-end sm:hidden"
              open={mobileMenuOpen}
              onToggle={(event) => setMobileMenuOpen((event.currentTarget as HTMLDetailsElement).open)}
            >
              <summary className="flex h-9 w-9 cursor-pointer list-none items-center justify-center rounded-full border border-slate-300/40 text-slate-100 marker:content-['']">
                <span className="sr-only">Open navigation menu</span>
                <span className="inline-flex flex-col gap-1.5">
                  <span className="block h-0.5 w-4 bg-current" />
                  <span className="block h-0.5 w-4 bg-current" />
                  <span className="block h-0.5 w-4 bg-current" />
                </span>
              </summary>

              <div className="absolute right-0 top-12 w-52 rounded-2xl border border-slate-200/10 bg-slate-950/95 p-4 text-sm text-slate-100 shadow-xl backdrop-blur-md">
                <ul className="m-0 list-none space-y-3 p-0">
                  {navItems.map((item) => (
                    <li key={`mobile-${item}`}>
                      <a
                        href="#"
                        className="block transition-colors hover:text-cyan-300"
                        onClick={() => setMobileMenuOpen(false)}
                      >
                        {item}
                      </a>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="mt-4 w-full rounded-full border border-cyan-300/40 px-4 py-2 text-xs font-semibold tracking-[0.08em] text-cyan-200 transition-colors hover:border-cyan-200 hover:text-cyan-100"
                >
                  Login · Guest
                </button>
              </div>
            </details>
          </div>
        </header>

        <InterestForm />
      </main>
      <footer className="pointer-events-none fixed inset-x-0 bottom-3 z-[5] px-4 text-right text-[0.72rem] tracking-[0.08em] text-slate-300/60">
        <span>ToS | GDPR | Terms | About</span>
      </footer>
    </>
  );
}
