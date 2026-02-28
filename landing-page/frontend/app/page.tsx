import { InterestForm } from '@/components/InterestForm';
import { OnboardingNetworkBackground } from '@/components/OnboardingNetworkBackground';

export default function HomePage() {
  return (
    <>
      <OnboardingNetworkBackground />
      <main className="relative z-10 grid min-h-screen w-full grid-rows-[auto_1fr] gap-4 px-4 py-8 sm:px-6 lg:px-10">
        <InterestForm />
      </main>
      <footer className="pointer-events-none fixed inset-x-0 bottom-3 z-[5] px-4 text-right text-[0.72rem] tracking-[0.08em] text-slate-300/60">
        <span>ToS | GDPR | Terms | About</span>
      </footer>
    </>
  );
}
