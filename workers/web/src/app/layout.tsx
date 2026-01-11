import type { Metadata } from 'next';
import '@/instrumentation-client';
import './globals.css';

export const metadata: Metadata = {
  title: 'Trace Flow - LLM Analytics',
  description: 'LLM Request Analytics Platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark h-full">
      <head>
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
      </head>
      <body className="h-full antialiased">{children}</body>
    </html>
  );
}
