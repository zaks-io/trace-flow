'use client';

import Link from 'next/link';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Layers,
  Key,
  Gauge,
  Terminal,
  Webhook,
} from 'lucide-react';

interface DocCard {
  title: string;
  description: string;
  href: string;
  icon: React.ElementType;
  tag?: string;
}

const GUIDES: DocCard[] = [
  {
    title: 'LLM Proxy',
    description:
      'Route LLM requests through the proxy for automatic tracing. Works with OpenAI, Anthropic, OpenRouter, and Groq.',
    href: '/docs/llm-proxy',
    icon: Webhook,
    tag: 'Getting Started',
  },
  {
    title: 'OpenTelemetry Integration',
    description:
      'Send hierarchical traces using the official OpenTelemetry SDK. Track LLM calls, HTTP requests, and custom events.',
    href: '/docs/opentelemetry',
    icon: Layers,
    tag: 'Advanced',
  },
];

const COMING_SOON: DocCard[] = [
  {
    title: 'API Keys',
    description: 'Create and manage API keys for authenticating with the Observe proxy.',
    href: '#',
    icon: Key,
  },
  {
    title: 'Metrics & Analytics',
    description: 'Query and visualize your trace data with Tinybird SQL.',
    href: '#',
    icon: Gauge,
  },
];

function DocCardLink({ card, disabled = false }: { card: DocCard; disabled?: boolean }) {
  const content = (
    <div
      className={`group relative flex h-full flex-col rounded-xl border p-6 transition-all duration-200 ${
        disabled
          ? 'cursor-not-allowed border-border/30 bg-card/30'
          : 'border-border/50 bg-card/50 hover:border-primary/30 hover:bg-card'
      }`}
    >
      {!disabled && (
        <div className="absolute -inset-px rounded-xl bg-gradient-to-b from-primary/10 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      )}
      <div className="relative flex flex-1 flex-col">
        <div className="mb-4 flex items-start justify-between">
          <div
            className={`flex h-10 w-10 items-center justify-center rounded-lg ${
              disabled ? 'bg-muted/50 text-muted-foreground/50' : 'bg-primary/10 text-primary'
            }`}
          >
            <card.icon className="h-5 w-5" />
          </div>
          {card.tag && (
            <span className="rounded-full border border-primary/20 bg-primary/5 px-2 py-0.5 font-mono text-xs text-primary">
              {card.tag}
            </span>
          )}
          {disabled && (
            <span className="rounded-full border border-border/50 bg-muted/30 px-2 py-0.5 font-mono text-xs text-muted-foreground">
              Soon
            </span>
          )}
        </div>
        <h3
          className={`mb-2 text-lg font-semibold ${disabled ? 'text-muted-foreground/70' : 'text-foreground'}`}
        >
          {card.title}
        </h3>
        <p
          className={`flex-1 text-sm ${disabled ? 'text-muted-foreground/50' : 'text-muted-foreground'}`}
        >
          {card.description}
        </p>
        {!disabled && (
          <div className="mt-4 flex items-center gap-1 text-sm text-primary opacity-0 transition-opacity group-hover:opacity-100">
            <span>Read guide</span>
            <ArrowRight className="h-4 w-4" />
          </div>
        )}
      </div>
    </div>
  );

  if (disabled) {
    return content;
  }

  return <Link href={card.href}>{content}</Link>;
}

export default function DocsPage() {
  return (
    <div className="min-h-screen bg-background">
      {/* Subtle grid background */}
      <div
        className="fixed inset-0 opacity-[0.02]"
        style={{
          backgroundImage: `linear-gradient(oklch(0.95 0.01 260) 1px, transparent 1px),
                           linear-gradient(90deg, oklch(0.95 0.01 260) 1px, transparent 1px)`,
          backgroundSize: '64px 64px',
        }}
      />

      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-6">
          <Link
            href="/"
            className="flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>Back to Observe</span>
          </Link>
          <div className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-primary" />
            <span className="font-mono text-sm text-muted-foreground">Documentation</span>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="relative mx-auto max-w-5xl px-6 py-16">
        {/* Hero */}
        <div className="mb-16 animate-fade-in">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1">
            <Terminal className="h-3.5 w-3.5 text-primary" />
            <span className="font-mono text-xs text-primary">Developer Documentation</span>
          </div>
          <h1 className="mb-4 text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
            Observe Docs
          </h1>
          <p className="max-w-2xl text-lg text-muted-foreground">
            Learn how to integrate Observe into your applications. Send traces, monitor LLM usage,
            and gain insights into your AI workflows.
          </p>
        </div>

        {/* Guides */}
        <section className="mb-16 animate-fade-in" style={{ animationDelay: '100ms' }}>
          <h2 className="mb-6 text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Integration Guides
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {GUIDES.map((card) => (
              <DocCardLink key={card.title} card={card} />
            ))}
          </div>
        </section>

        {/* Coming Soon */}
        <section className="animate-fade-in" style={{ animationDelay: '200ms' }}>
          <h2 className="mb-6 text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Coming Soon
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {COMING_SOON.map((card) => (
              <DocCardLink key={card.title} card={card} disabled />
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
                <Key className="h-4 w-4 text-primary" />
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

        {/* Footer */}
        <footer className="mt-20 border-t border-border/50 pt-8">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>Observe — LLM Analytics Platform</span>
            <Link href="/app" className="text-primary transition-colors hover:text-primary/80">
              Open Dashboard →
            </Link>
          </div>
        </footer>
      </main>
    </div>
  );
}
