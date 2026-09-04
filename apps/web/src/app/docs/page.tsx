import Link from 'next/link';
import { Terminal, ExternalLink, Gauge, KeyRound, Layers, FileCode } from 'lucide-react';
import { getDocs, getDocPath } from '@/lib/docs';

export default function DocsIndexPage() {
  const guides = getDocs();

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
          Connect model API traffic or the local coding-agent collector, then investigate both with
          the dashboard and MCP.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/docs/quick-start"
            className="inline-flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2 text-sm text-foreground transition-colors hover:bg-primary/15"
          >
            <Gauge className="h-4 w-4 text-primary" />
            <span>Start Here</span>
          </Link>
          <Link
            href="/agents.md"
            className="inline-flex items-center gap-2 rounded-lg border border-border/50 bg-card/50 px-4 py-2 text-sm text-foreground transition-colors hover:border-primary/30 hover:bg-card"
          >
            <FileCode className="h-4 w-4 text-primary" />
            <span>For AI Agents</span>
          </Link>
        </div>
      </div>

      <section className="mb-16 animate-fade-in" style={{ animationDelay: '60ms' }}>
        <div className="rounded-2xl border border-primary/20 bg-primary/5 p-6">
          <h2 className="text-lg font-semibold text-foreground">New workspace?</h2>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Start with Quick Start for model API traffic. For local Claude Code, Codex CLI, or
            Cursor activity, use the Coding-Agent Collector guide. If an agent is wiring the gateway
            into a repository, give it <code>/agents.md</code>.
          </p>
        </div>
      </section>

      {/* Guides */}
      <section className="mb-16 animate-fade-in" style={{ animationDelay: '100ms' }}>
        <h2 className="mb-6 text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Integration Guides
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {guides.map((card) => (
            <Link key={card.slug} href={getDocPath(card.slug)} className="group">
              <div className="relative flex h-full flex-col rounded-xl border border-border/50 bg-card/50 p-6 transition-all duration-200 hover:border-primary/30 hover:bg-card">
                <div className="absolute -inset-px rounded-xl bg-linear-to-b from-primary/10 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
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
            <Link
              href="/llms.txt"
              className="inline-flex items-center gap-2 rounded-lg border border-border/50 bg-background px-4 py-2 text-sm text-foreground transition-colors hover:border-primary/30 hover:bg-primary/5"
            >
              <FileCode className="h-4 w-4 text-primary" />
              <span>llms.txt</span>
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
