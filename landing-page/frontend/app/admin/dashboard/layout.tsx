import { PropsWithChildren } from 'react';
import { AdminConsoleLayout } from '@/components/AdminConsoleLayout';

export default function DashboardLayout({ children }: PropsWithChildren) {
  return <AdminConsoleLayout>{children}</AdminConsoleLayout>;
}
