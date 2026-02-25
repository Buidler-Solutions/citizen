import Link from 'next/link';
import { InterestForm } from '@/components/InterestForm';

export default function HomePage() {
  return (
    <main className="landing-main typeform-main">
      <Link className="admin-link" href="/admin/login">
        Admin login
      </Link>
      <InterestForm />
    </main>
  );
}
