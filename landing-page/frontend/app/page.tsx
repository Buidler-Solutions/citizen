import { InterestForm } from '@/components/InterestForm';
import { OnboardingNetworkBackground } from '@/components/OnboardingNetworkBackground';

export default function HomePage() {
  return (
    <>
      <OnboardingNetworkBackground />
      <main className="relative z-10 mx-auto grid min-h-screen w-[min(980px,92vw)] grid-rows-[auto_1fr] gap-4 py-8">
        <InterestForm />
      </main>
    </>
  );
}
