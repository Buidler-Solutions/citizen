import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Citizen Protocol-v0.1.0 | Blockchain tailor-made for Government INFRA',
  description: 'A stunning government-focused landing page for the Citizen Protocol pitch for government.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
