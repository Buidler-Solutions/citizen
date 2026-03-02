import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Citizen Protocol Whitepaper',
  description: 'Official scroll-driven whitepaper experience for Citizen Protocol.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
