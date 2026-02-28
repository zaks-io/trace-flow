import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';

const docPages = [
  { title: 'Quick Start', href: '/docs/quick-start' },
  { title: 'SDK Reference', href: '/docs/sdk-reference' },
  { title: 'OpenTelemetry', href: '/docs/opentelemetry' },
  { title: 'AI Agents', href: '/docs/agents' },
  { title: 'MCP', href: '/docs/mcp' },
];

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <Link
          href="/"
          className="mb-8 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          Back to Home
        </Link>

        <div className="grid gap-8 lg:grid-cols-[240px_1fr]">
          {/* Sidebar */}
          <nav className="space-y-1">
            <h2 className="mb-4 text-lg font-semibold">Documentation</h2>
            {docPages.map((page) => (
              <Link
                key={page.href}
                href={page.href}
                className="block rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {page.title}
              </Link>
            ))}
          </nav>

          {/* Content */}
          <main className="prose prose-invert max-w-none">{children}</main>
        </div>
      </div>
    </div>
  );
}
