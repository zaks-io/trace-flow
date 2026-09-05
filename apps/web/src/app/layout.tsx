import type { Metadata } from 'next';
import { Plus_Jakarta_Sans, Fira_Code } from 'next/font/google';
import './globals.css';

const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-jakarta',
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

const firaCode = Fira_Code({
  subsets: ['latin'],
  variable: '--font-fira-code',
  weight: ['400', '500', '600'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Trace Flow | Your AI cost and performance history',
  description:
    'Collect model and coding-agent analytics in the background. Track costs and performance over time with Trace Flow. Private alpha.',
  openGraph: {
    title: 'Trace Flow | Your AI cost and performance history',
    description:
      'Keep a history of your AI work. Track spending, performance, and wasted tokens across model calls and coding agents. Private alpha.',
    url: 'https://trace-flow.dev',
    siteName: 'Trace Flow',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Trace Flow | Your AI cost and performance history',
    description:
      'Keep a history of your AI work. Track spending, performance, and wasted tokens across model calls and coding agents. Private alpha.',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark h-full ${jakarta.variable} ${firaCode.variable}`}>
      <head>
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
      </head>
      <body className="h-full antialiased">{children}</body>
    </html>
  );
}
