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
  title: 'Trace Flow | Coding-agent and model-call analytics',
  description:
    'Track estimated costs, context growth, and tool failures across coding sessions, plus model-call usage and performance.',
  openGraph: {
    title: 'Trace Flow | Coding-agent and model-call analytics',
    description:
      'Track estimated costs, context growth, and tool failures across coding sessions, plus model-call usage and performance.',
    url: 'https://trace-flow.dev',
    siteName: 'Trace Flow',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Trace Flow | Coding-agent and model-call analytics',
    description:
      'Track estimated costs, context growth, and tool failures across coding sessions, plus model-call usage and performance.',
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
