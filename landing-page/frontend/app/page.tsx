import { InterestForm } from '@/components/InterestForm';

export default function HomePage() {
  return (
    <main className="mx-auto grid min-h-screen w-[min(980px,92vw)] grid-rows-[auto_1fr] gap-4 py-8">
      <InterestForm />
    </main>
  );
}
