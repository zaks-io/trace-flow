'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Cpu, MousePointer2, ExternalLink, FileText, Copy, Check } from 'lucide-react';

export default function AgentsPage() {
  const [agentsContent, setAgentsContent] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void fetch('/agents.md')
      .then((res) => res.text())
      .then(setAgentsContent);
  }, []);

  const estimatedTokens = Math.ceil(agentsContent.length / 4);

  const handleCopy = () => {
    void navigator.clipboard.writeText(agentsContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      {/* Hero */}
      <div className="mb-16 animate-fade-in">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1">
          <Cpu className="h-3.5 w-3.5 text-primary" />
          <span className="font-mono text-xs text-primary">AI Agents</span>
        </div>
        <h1 className="mb-4 text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
          Bootstrap Your AI Assistant
        </h1>
        <p className="max-w-2xl text-lg text-muted-foreground">
          Give Claude Code, Cursor, or any AI assistant instant knowledge of Trace Flow. Copy the
          integration guide into your context or link directly to the file.
        </p>
      </div>

      {/* How to Use */}
      <div className="mb-12 animate-fade-in" style={{ animationDelay: '100ms' }}>
        <h2 className="mb-6 text-sm font-medium uppercase tracking-wider text-muted-foreground">
          How to Use
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {/* Claude Code */}
          <div className="rounded-xl border border-border/50 bg-card/50 p-5">
            <div className="mb-3 flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[oklch(0.75_0.12_50)]/10 text-[oklch(0.75_0.12_50)]">
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm3.174 3.662L6.53 13.641h6.441l-3.228-6.46z" />
                </svg>
              </div>
              <h3 className="font-semibold text-foreground">Claude Code</h3>
            </div>
            <p className="text-sm text-muted-foreground">
              Add to your project&apos;s{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">CLAUDE.md</code>{' '}
              file, or paste directly when starting a session.
            </p>
          </div>

          {/* Cursor */}
          <div className="rounded-xl border border-border/50 bg-card/50 p-5">
            <div className="mb-3 flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[oklch(0.7_0.15_262)]/10 text-[oklch(0.7_0.15_262)]">
                <MousePointer2 className="h-4 w-4" />
              </div>
              <h3 className="font-semibold text-foreground">Cursor</h3>
            </div>
            <p className="text-sm text-muted-foreground">
              Add to your{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">.cursorrules</code>{' '}
              file, or include via{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">@file</code>{' '}
              reference.
            </p>
          </div>

          {/* Other */}
          <div className="rounded-xl border border-border/50 bg-card/50 p-5">
            <div className="mb-3 flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Cpu className="h-4 w-4" />
              </div>
              <h3 className="font-semibold text-foreground">Any AI Assistant</h3>
            </div>
            <p className="text-sm text-muted-foreground">
              Copy the content below and paste it into your assistant&apos;s context window when
              working with Trace Flow.
            </p>
          </div>
        </div>
      </div>

      {/* Direct Link */}
      <div className="mb-8 animate-fade-in" style={{ animationDelay: '150ms' }}>
        <div className="rounded-xl border border-border/50 bg-card/30 p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="mb-1 font-medium text-foreground">Direct File Link</h3>
              <p className="text-sm text-muted-foreground">
                Point your assistant to fetch this file directly when needed:
              </p>
            </div>
            <a
              href="/agents.md"
              target="_blank"
              className="inline-flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2 font-mono text-sm text-primary transition-colors hover:bg-primary/20"
            >
              <ExternalLink className="h-4 w-4" />
              trace-flow.dev/agents.md
            </a>
          </div>
          <div className="mt-4 rounded-lg bg-muted/30 p-3">
            <p className="font-mono text-xs text-muted-foreground">
              &quot;If you need more information on Trace Flow, fetch
              https://trace-flow.dev/agents.md&quot;
            </p>
          </div>
        </div>
      </div>

      {/* Integration Guide Content */}
      <div className="animate-fade-in" style={{ animationDelay: '200ms' }}>
        <div className="rounded-xl border border-border/50 bg-card/30">
          <div className="flex items-center justify-between border-b border-border/50 px-5 py-4">
            <div className="flex items-center gap-3">
              <FileText className="h-5 w-5 text-primary" />
              <div>
                <h3 className="font-medium text-foreground">agents.md</h3>
                <p className="text-xs text-muted-foreground">~{estimatedTokens} tokens</p>
              </div>
            </div>
            <button
              onClick={handleCopy}
              className="flex items-center gap-2 rounded-lg border border-border/50 bg-background/50 px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {copied ? (
                <>
                  <Check className="h-4 w-4 text-[oklch(0.7_0.18_145)]" />
                  <span>Copied!</span>
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" />
                  <span>Copy to Clipboard</span>
                </>
              )}
            </button>
          </div>
          <pre className="max-h-[32rem] overflow-auto p-5 font-mono text-sm leading-relaxed text-foreground/90">
            {agentsContent}
          </pre>
        </div>
      </div>

      {/* Tips */}
      <div className="mt-12 animate-fade-in" style={{ animationDelay: '250ms' }}>
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-6">
          <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-primary">
            Tips for AI Assistants
          </h3>
          <ul className="space-y-3 text-sm text-foreground">
            <li className="flex items-start gap-3">
              <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span>
                <strong>On-demand loading:</strong> Only include this in context when working on
                Trace Flow integration. Remove it when working on unrelated code to save tokens.
              </span>
            </li>
            <li className="flex items-start gap-3">
              <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span>
                <strong>Fetch when needed:</strong> Tell your assistant to fetch the agents.md file
                when it needs more context, rather than always including it.
              </span>
            </li>
            <li className="flex items-start gap-3">
              <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span>
                <strong>More documentation:</strong> The agents.md file includes links to detailed
                docs for advanced topics like OpenTelemetry setup and per-provider examples.
              </span>
            </li>
          </ul>
        </div>
      </div>

      {/* Next Steps */}
      <div className="mt-12 animate-fade-in" style={{ animationDelay: '300ms' }}>
        <h2 className="mb-6 text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Full Documentation
        </h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <Link href="/docs/quick-start" className="group">
            <div className="relative flex h-full flex-col rounded-xl border border-border/50 bg-card/50 p-5 transition-all duration-200 hover:border-primary/30 hover:bg-card">
              <h3 className="mb-1 font-semibold text-foreground">Quick Start</h3>
              <p className="text-sm text-muted-foreground">Full integration walkthrough</p>
            </div>
          </Link>
          <Link href="/docs/sdk-reference" className="group">
            <div className="relative flex h-full flex-col rounded-xl border border-border/50 bg-card/50 p-5 transition-all duration-200 hover:border-primary/30 hover:bg-card">
              <h3 className="mb-1 font-semibold text-foreground">SDK Reference</h3>
              <p className="text-sm text-muted-foreground">All provider examples</p>
            </div>
          </Link>
          <Link href="/docs/opentelemetry" className="group">
            <div className="relative flex h-full flex-col rounded-xl border border-border/50 bg-card/50 p-5 transition-all duration-200 hover:border-primary/30 hover:bg-card">
              <h3 className="mb-1 font-semibold text-foreground">OpenTelemetry</h3>
              <p className="text-sm text-muted-foreground">Advanced tracing setup</p>
            </div>
          </Link>
        </div>
      </div>
    </>
  );
}
