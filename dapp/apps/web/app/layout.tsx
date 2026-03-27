import "./globals.css";

export const metadata = {
  title: "Citizen DApp Showcase",
  description: "Explore Citizen blockchain capabilities with a Next.js + NestJS demo."
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
