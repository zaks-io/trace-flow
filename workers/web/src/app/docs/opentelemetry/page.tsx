'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { ArrowLeft, Copy, Check, Terminal, Layers, Zap, BookOpen } from 'lucide-react';
import { codeToHtml } from 'shiki';

function CodeBlock({ code, language = 'typescript' }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);

  useEffect(() => {
    void codeToHtml(code, {
      lang: language === 'bash' ? 'bash' : 'typescript',
      theme: 'github-dark-default',
    }).then(setHighlightedHtml);
  }, [code, language]);

  const handleCopy = () => {
    void navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="group relative">
      <div className="absolute -inset-px rounded-xl bg-gradient-to-b from-primary/20 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      <div className="relative overflow-hidden rounded-xl border border-border/50 bg-[oklch(0.1_0.01_260)]">
        <div className="flex items-center justify-between border-b border-border/30 px-4 py-2">
          <div className="flex items-center gap-2">
            <div className="flex gap-1.5">
              <div className="h-3 w-3 rounded-full bg-[oklch(0.6_0.2_25)]" />
              <div className="h-3 w-3 rounded-full bg-[oklch(0.75_0.15_85)]" />
              <div className="h-3 w-3 rounded-full bg-[oklch(0.7_0.18_145)]" />
            </div>
            <span className="ml-2 font-mono text-xs text-muted-foreground">{language}</span>
          </div>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5 text-[oklch(0.7_0.18_145)]" />
                <span>Copied</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                <span>Copy</span>
              </>
            )}
          </button>
        </div>
        <div className="overflow-x-auto p-4 text-sm leading-relaxed [&_pre]:!bg-transparent [&_code]:!bg-transparent">
          {highlightedHtml ? (
            <div dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
          ) : (
            <pre>
              <code className="font-mono text-[oklch(0.85_0.02_260)]">{code}</code>
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionCard({
  icon: Icon,
  title,
  children,
  className = '',
}: {
  icon: React.ElementType;
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`relative ${className}`}>
      <div className="mb-6 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </div>
        <h2 className="text-xl font-semibold tracking-tight text-foreground">{title}</h2>
      </div>
      {children}
    </section>
  );
}

const INSTALL_CODE = `npm install @opentelemetry/api @opentelemetry/sdk-trace-base \\
  @opentelemetry/exporter-trace-otlp-http \\
  @opentelemetry/resources @opentelemetry/semantic-conventions`;

const SETUP_CODE = `import { trace, context, SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

// Initialize once at module level
const exporter = new OTLPTraceExporter({
  url: "https://your-observe-proxy.workers.dev/v1/traces",
  headers: { "X-Observe-Api-Key": process.env.OBSERVE_API_KEY! },
});

const provider = new BasicTracerProvider({
  resource: new Resource({ [ATTR_SERVICE_NAME]: "my-service" }),
});

// SimpleSpanProcessor sends immediately (ideal for serverless)
provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
provider.register();

export const tracer = trace.getTracer("my-service");`;

const SPANS_CODE = `async function handleRequest(request: Request) {
  // Create root span
  const rootSpan = tracer.startSpan("handle-request");

  return context.with(trace.setSpan(context.active(), rootSpan), async () => {
    // Add user events to the span
    rootSpan.addEvent("user.click", { button: "submit" });

    // Child spans are automatically linked via context
    const httpSpan = tracer.startSpan("fetch-data");
    const data = await fetch("/api/data");
    httpSpan.setAttribute("http.status_code", data.status);
    httpSpan.end();

    // Another child span for LLM call
    const llmSpan = tracer.startSpan("llm-call");
    llmSpan.setAttribute("llm.model", "gpt-4");
    llmSpan.setAttribute("llm.provider", "openai");
    // ... make LLM call
    llmSpan.end();

    rootSpan.setStatus({ code: SpanStatusCode.OK });
    rootSpan.end();

    return new Response("OK");
  });
}`;

const FLUSH_CODE = `export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const response = await handleRequest(request);

    // Force flush before worker terminates
    ctx.waitUntil(provider.forceFlush());

    return response;
  },
};`;

export default function OpenTelemetryDocsPage() {
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
        <div className="mx-auto flex h-16 max-w-4xl items-center justify-between px-6">
          <Link
            href="/docs"
            className="flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>Back to Docs</span>
          </Link>
          <div className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-primary" />
            <span className="font-mono text-sm text-muted-foreground">v1.0</span>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="relative mx-auto max-w-4xl px-6 py-16">
        {/* Hero */}
        <div className="mb-20 animate-fade-in">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1">
            <Terminal className="h-3.5 w-3.5 text-primary" />
            <span className="font-mono text-xs text-primary">OpenTelemetry Integration</span>
          </div>
          <h1 className="mb-4 text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
            Integrate with Observe
          </h1>
          <p className="max-w-2xl text-lg text-muted-foreground">
            Send hierarchical traces from your application using the official OpenTelemetry SDK.
            Track LLM calls, HTTP requests, and custom events with parent-child relationships.
          </p>
        </div>

        {/* Span hierarchy visualization */}
        <div className="mb-16 animate-fade-in" style={{ animationDelay: '100ms' }}>
          <div className="rounded-xl border border-border/50 bg-card/50 p-6">
            <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-muted-foreground">
              Span Hierarchy
            </h3>
            <div className="font-mono text-sm">
              <div className="text-foreground">
                <span className="text-primary">Trace</span>{' '}
                <span className="text-muted-foreground">(traceId)</span>
              </div>
              <div className="ml-4 border-l border-border/50 pl-4">
                <div className="relative">
                  <div className="absolute -left-[17px] top-3 h-px w-3 bg-border/50" />
                  <div className="text-foreground">
                    Root Span{' '}
                    <span className="text-muted-foreground text-xs">
                      (parentSpanId = &quot;&quot;)
                    </span>
                  </div>
                </div>
                <div className="ml-4 border-l border-border/50 pl-4">
                  <div className="relative">
                    <div className="absolute -left-[17px] top-3 h-px w-3 bg-border/50" />
                    <div className="text-[oklch(0.7_0.18_145)]">
                      HTTP Call{' '}
                      <span className="text-muted-foreground text-xs">
                        (parentSpanId = root.spanId)
                      </span>
                    </div>
                  </div>
                  <div className="relative">
                    <div className="absolute -left-[17px] top-3 h-px w-3 bg-border/50" />
                    <div className="text-[oklch(0.7_0.15_262)]">
                      LLM Call{' '}
                      <span className="text-muted-foreground text-xs">
                        (parentSpanId = root.spanId)
                      </span>
                    </div>
                  </div>
                  <div className="ml-4 border-l border-border/50 pl-4">
                    <div className="relative">
                      <div className="absolute -left-[17px] top-3 h-px w-3 bg-border/50" />
                      <div className="text-[oklch(0.75_0.12_50)]">
                        Nested Span{' '}
                        <span className="text-muted-foreground text-xs">
                          (parentSpanId = llm.spanId)
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Sections */}
        <div className="space-y-16">
          {/* Install */}
          <SectionCard icon={Terminal} title="Install Dependencies" className="animate-fade-in">
            <CodeBlock code={INSTALL_CODE} language="bash" />
          </SectionCard>

          {/* Setup */}
          <SectionCard icon={Zap} title="Initialize the Tracer" className="animate-fade-in">
            <p className="mb-4 text-muted-foreground">
              Initialize the OpenTelemetry provider once at module level. Use{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm text-foreground">
                SimpleSpanProcessor
              </code>{' '}
              for serverless environments—it sends spans immediately without batching.
            </p>
            <CodeBlock code={SETUP_CODE} language="typescript" />
          </SectionCard>

          {/* Spans */}
          <SectionCard icon={Layers} title="Create Hierarchical Spans" className="animate-fade-in">
            <p className="mb-4 text-muted-foreground">
              Use{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm text-foreground">
                context.with()
              </code>{' '}
              to establish parent-child relationships. Child spans created within the context
              automatically inherit the parent span ID.
            </p>
            <CodeBlock code={SPANS_CODE} language="typescript" />
          </SectionCard>

          {/* Flush */}
          <SectionCard icon={Zap} title="Serverless Flush Pattern" className="animate-fade-in">
            <p className="mb-4 text-muted-foreground">
              In serverless environments like Cloudflare Workers, always flush traces before the
              function terminates. Use{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm text-foreground">
                waitUntil()
              </code>{' '}
              to avoid blocking the response.
            </p>
            <CodeBlock code={FLUSH_CODE} language="typescript" />
          </SectionCard>
        </div>

        {/* Key points */}
        <div className="mt-20 animate-fade-in">
          <div className="rounded-xl border border-primary/20 bg-primary/5 p-6">
            <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-primary">
              Key Points
            </h3>
            <ul className="space-y-3 text-sm text-foreground">
              <li className="flex items-start gap-3">
                <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                <span>
                  <strong>Parent spans work automatically</strong> — OTEL SDK&apos;s{' '}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                    context.with()
                  </code>{' '}
                  links child spans
                </span>
              </li>
              <li className="flex items-start gap-3">
                <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                <span>
                  <strong>Events are supported</strong> —{' '}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                    span.addEvent()
                  </code>{' '}
                  maps to the Events columns in Tinybird
                </span>
              </li>
              <li className="flex items-start gap-3">
                <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                <span>
                  <strong>Attributes work</strong> —{' '}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                    span.setAttribute()
                  </code>{' '}
                  maps to the SpanAttributes JSON column
                </span>
              </li>
              <li className="flex items-start gap-3">
                <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                <span>
                  <strong>Use SimpleSpanProcessor</strong> for serverless (sends immediately)
                </span>
              </li>
              <li className="flex items-start gap-3">
                <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                <span>
                  <strong>Call forceFlush()</strong> in{' '}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                    waitUntil()
                  </code>{' '}
                  before function exits
                </span>
              </li>
            </ul>
          </div>
        </div>

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
