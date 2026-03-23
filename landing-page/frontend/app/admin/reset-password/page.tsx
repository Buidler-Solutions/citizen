import { ResetPasswordForm } from './reset-password-form';

interface ResetPasswordPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ResetPasswordPage({ searchParams }: ResetPasswordPageProps) {
  const resolved = await searchParams;
  const email = typeof resolved?.email === 'string' ? resolved.email : '';
  const token = typeof resolved?.token === 'string' ? resolved.token : '';

  return <ResetPasswordForm initialEmail={email} initialToken={token} />;
}
