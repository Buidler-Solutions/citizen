import './globals.css';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'Citizen Explorer',
  description: 'Blockchain explorer for the Citizen Protocol.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
