import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Citizen Protocol | Government Adoption Pitch',
  description: 'A stunning government-focused landing page for the Citizen Protocol pitch.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
