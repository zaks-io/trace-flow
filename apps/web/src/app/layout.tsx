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
  title: 'Trace Flow | Observability for models and coding agents',
  description:
    'Follow LLM requests and local coding-agent sessions in one place. Trace Flow is currently in private alpha.',
  openGraph: {
    title: 'Trace Flow | Observability for models and coding agents',
    description:
      'See cost, context growth, tool reliability, and model usage across LLM requests and coding-agent sessions.',
    url: 'https://trace-flow.dev',
    siteName: 'Trace Flow',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Trace Flow | Observability for models and coding agents',
    description:
      'See cost, context growth, tool reliability, and model usage across LLM requests and coding-agent sessions.',
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
