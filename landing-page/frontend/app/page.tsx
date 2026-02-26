import Link from 'next/link';
import { InterestForm } from '@/components/InterestForm';

export default function HomePage() {
  return (
    <main className="mx-auto grid min-h-screen w-[min(980px,92vw)] grid-rows-[auto_1fr] gap-4 py-8">
      <Link
        className="fixed right-4 top-4 font-semibold text-sky-200 no-underline transition hover:text-sky-100"
        href="/admin/login"
      >
        Admin login
      </Link>
      <InterestForm />
    </main>
  );
}
