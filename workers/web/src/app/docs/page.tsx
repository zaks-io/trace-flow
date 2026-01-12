import Link from 'next/link';
import { Terminal, ExternalLink, Gauge, KeyRound, Layers } from 'lucide-react';

const GUIDES = [
  {
    title: 'Quick Start',
    description:
      'Get full LLM observability in minutes. See user events, API calls, and LLM requests in one unified trace.',
    href: '/docs/quick-start',
    tag: 'Start Here',
  },
  {
    title: 'SDK Reference',
    description:
      'Provider-specific examples for OpenAI, Anthropic, OpenRouter, and Groq with Vercel AI SDK and native SDKs.',
    href: '/docs/sdk-reference',
    tag: 'Reference',
  },
  {
    title: 'OpenTelemetry',
    description:
      'Advanced setup for custom spans, events, and attributes. Full control over your trace hierarchy.',
    href: '/docs/opentelemetry',
    tag: 'Advanced',
  },
  {
    title: 'AI Agents',
    description:
      'Bootstrap Claude Code, Cursor, or any AI assistant with Trace Flow knowledge. Copy-paste ready.',
    href: '/docs/agents',
    tag: 'Agents',
  },
  {
    title: 'MCP Server',
    description:
      'Give AI agents direct access to your trace data. Query traces, analyze costs, and debug issues.',
    href: '/docs/mcp',
    tag: 'MCP',
  },
];

export default function DocsIndexPage() {
  return (
    <>
      {/* Hero */}
      <div className="mb-16 animate-fade-in">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1">
          <Terminal className="h-3.5 w-3.5 text-primary" />
          <span className="font-mono text-xs text-primary">Developer Documentation</span>
        </div>
        <h1 className="mb-4 text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
          Trace Flow Docs
        </h1>
        <p className="max-w-2xl text-lg text-muted-foreground">
          Learn how to integrate Trace Flow into your applications. Send traces, monitor LLM usage,
          and gain insights into your AI workflows.
        </p>
      </div>

      {/* Guides */}
      <section className="mb-16 animate-fade-in" style={{ animationDelay: '100ms' }}>
        <h2 className="mb-6 text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Integration Guides
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {GUIDES.map((card) => (
            <Link key={card.href} href={card.href} className="group">
              <div className="relative flex h-full flex-col rounded-xl border border-border/50 bg-card/50 p-6 transition-all duration-200 hover:border-primary/30 hover:bg-card">
                <div className="absolute -inset-px rounded-xl bg-gradient-to-b from-primary/10 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
                <div className="relative flex flex-1 flex-col">
                  <div className="mb-4 flex items-start justify-between">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <ExternalLink className="h-5 w-5" />
                    </div>
                    {card.tag && (
                      <span className="rounded-full border border-primary/20 bg-primary/5 px-2 py-0.5 font-mono text-xs text-primary">
                        {card.tag}
                      </span>
                    )}
                  </div>
                  <h3 className="mb-2 text-lg font-semibold text-foreground">{card.title}</h3>
                  <p className="flex-1 text-sm text-muted-foreground">{card.description}</p>
                  <div className="mt-4 flex items-center gap-1 text-sm text-primary opacity-0 transition-opacity group-hover:opacity-100">
                    <span>Read guide</span>
                    <svg
                      className="h-4 w-4"
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M5 12h14" />
                      <path d="m12 5 7 7-7 7" />
                    </svg>
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* Quick Links */}
      <section className="mt-16 animate-fade-in" style={{ animationDelay: '300ms' }}>
        <div className="rounded-xl border border-border/50 bg-card/50 p-6">
          <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Quick Links
          </h3>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/app"
              className="inline-flex items-center gap-2 rounded-lg border border-border/50 bg-background px-4 py-2 text-sm text-foreground transition-colors hover:border-primary/30 hover:bg-primary/5"
            >
              <Gauge className="h-4 w-4 text-primary" />
              <span>Dashboard</span>
            </Link>
            <Link
              href="/app/api-keys"
              className="inline-flex items-center gap-2 rounded-lg border border-border/50 bg-background px-4 py-2 text-sm text-foreground transition-colors hover:border-primary/30 hover:bg-primary/5"
            >
              <KeyRound className="h-4 w-4 text-primary" />
              <span>API Keys</span>
            </Link>
            <Link
              href="/app/traces"
              className="inline-flex items-center gap-2 rounded-lg border border-border/50 bg-background px-4 py-2 text-sm text-foreground transition-colors hover:border-primary/30 hover:bg-primary/5"
            >
              <Layers className="h-4 w-4 text-primary" />
              <span>Traces</span>
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
