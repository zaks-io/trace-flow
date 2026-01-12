import Link from 'next/link';
import { CodeBlock } from '@/components/docs/CodeBlock';
import { Zap, User, Loader2, Cpu, Wrench, Check, ArrowRight, KeyRound } from 'lucide-react';

const INSTALL_CODE = `npm install ai @ai-sdk/openai`;

const PROVIDER_CODE = `import { createOpenAI } from "@ai-sdk/openai";

const openai = createOpenAI({
  baseURL: "https://gateway.trace-flow.dev/openai/v1",
  apiKey: process.env.OPENAI_API_KEY,
  headers: {
    "X-Trace-Flow-Api-Key": process.env.TRACE_FLOW_API_KEY,
  },
});`;

const LINKED_CODE = `import { trace, context } from "@opentelemetry/api";
import { generateText } from "ai";

// Get the current span context from your tracer
const parentSpan = tracer.startSpan("user-request");
const ctx = parentSpan.spanContext();

// Pass trace context to link this LLM call to your trace
const result = await generateText({
  model: openai("gpt-5"),
  prompt: userMessage,
  headers: {
    "X-Trace-Flow-Trace-Id": ctx.traceId,
    "X-Trace-Flow-Parent-Span-Id": ctx.spanId,
  },
});

parentSpan.end();`;

export default function QuickStartPage() {
  return (
    <>
      {/* Hero */}
      <div className="mb-16 animate-fade-in">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1">
          <Zap className="h-3.5 w-3.5 text-primary" />
          <span className="font-mono text-xs text-primary">Quick Start</span>
        </div>
        <h1 className="mb-4 text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
          See Your Entire LLM Workflow
        </h1>
        <p className="max-w-2xl text-lg text-muted-foreground">
          Get full observability in minutes. Trace every step from user input to final response,
          including API calls, LLM requests, tool calls, and agent chains.
        </p>
      </div>

      {/* Trace Flow Diagram */}
      <div className="mb-16 animate-fade-in" style={{ animationDelay: '100ms' }}>
        <div className="rounded-xl border border-border/50 bg-card/30 p-6">
          <h3 className="mb-6 text-sm font-medium uppercase tracking-wider text-muted-foreground">
            What You&apos;ll See in Trace Flow
          </h3>
          <div className="flex flex-wrap items-center justify-center gap-3 font-mono text-sm">
            <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-primary">
              <User className="h-4 w-4" />
              <span>User Event</span>
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
            <div className="flex items-center gap-2 rounded-lg border border-[oklch(0.7_0.18_145)]/30 bg-[oklch(0.7_0.18_145)]/10 px-3 py-2 text-[oklch(0.7_0.18_145)]">
              <Loader2 className="h-4 w-4" />
              <span>API Call</span>
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
            <div className="flex items-center gap-2 rounded-lg border border-[oklch(0.7_0.15_262)]/30 bg-[oklch(0.7_0.15_262)]/10 px-3 py-2 text-[oklch(0.7_0.15_262)]">
              <Cpu className="h-4 w-4" />
              <span>LLM Request</span>
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
            <div className="flex items-center gap-2 rounded-lg border border-[oklch(0.75_0.12_50)]/30 bg-[oklch(0.75_0.12_50)]/10 px-3 py-2 text-[oklch(0.75_0.12_50)]">
              <Wrench className="h-4 w-4" />
              <span>Tool Calls</span>
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
            <div className="flex items-center gap-2 rounded-lg border border-[oklch(0.7_0.2_160)]/30 bg-[oklch(0.7_0.2_160)]/10 px-3 py-2 text-[oklch(0.7_0.2_160)]">
              <Check className="h-4 w-4" />
              <span>Response</span>
            </div>
          </div>
          <p className="mt-6 text-center text-sm text-muted-foreground">
            All steps appear as connected spans in your trace view, showing timing, token usage, and
            request/response bodies.
          </p>
        </div>
      </div>

      {/* Step 1: Install */}
      <div className="space-y-12">
        <section className="animate-fade-in" style={{ animationDelay: '150ms' }}>
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-lg font-bold text-primary">
              1
            </div>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">
              Install the SDK
            </h2>
          </div>
          <p className="mb-4 text-muted-foreground">
            We recommend the Vercel AI SDK for its unified interface across providers. See the{' '}
            <Link href="/docs/sdk-reference" className="text-primary hover:underline">
              SDK Reference
            </Link>{' '}
            for other options.
          </p>
          <CodeBlock code={INSTALL_CODE} lang="bash" />
        </section>

        {/* Get API Key */}
        <section className="animate-fade-in" style={{ animationDelay: '175ms' }}>
          <div className="rounded-xl border border-primary/20 bg-primary/5 p-6">
            <div className="flex items-start gap-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <KeyRound className="h-5 w-5" />
              </div>
              <div>
                <h3 className="mb-1 font-semibold text-foreground">Get Your API Key</h3>
                <p className="mb-3 text-sm text-muted-foreground">
                  Create an API key in the dashboard to authenticate requests through the Trace Flow
                  gateway.
                </p>
                <Link
                  href="/app/api-keys"
                  className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                >
                  <span>Create API Key</span>
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </div>
          </div>
        </section>

        {/* Step 2: Configure */}
        <section className="animate-fade-in" style={{ animationDelay: '200ms' }}>
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-lg font-bold text-primary">
              2
            </div>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">
              Configure Your Provider
            </h2>
          </div>
          <p className="mb-4 text-muted-foreground">
            Point your provider at the Trace Flow gateway. Add your{' '}
            <Link href="/app/api-keys" className="text-primary hover:underline">
              Trace Flow API key
            </Link>{' '}
            in the headers.
          </p>
          <CodeBlock code={PROVIDER_CODE} lang="typescript" />
          <p className="mt-4 text-sm text-muted-foreground">
            That&apos;s it for basic usage. LLM requests will now appear in your{' '}
            <Link href="/app/traces" className="text-primary hover:underline">
              Traces dashboard
            </Link>
            .
          </p>
        </section>

        {/* Step 3: Link to traces */}
        <section className="animate-fade-in" style={{ animationDelay: '250ms' }}>
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-lg font-bold text-primary">
              3
            </div>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">
              Link to Your Traces
            </h2>
          </div>
          <div className="mb-6 rounded-lg border border-primary/20 bg-primary/5 p-4">
            <p className="text-sm text-foreground">
              <strong>This is the key integration.</strong> Pass trace context headers to connect
              LLM calls to your existing OpenTelemetry traces. This creates a unified view of your
              entire workflow.
            </p>
          </div>
          <CodeBlock code={LINKED_CODE} lang="typescript" />
        </section>

        {/* Headers Reference */}
        <section className="animate-fade-in" style={{ animationDelay: '300ms' }}>
          <div className="rounded-xl border border-border/50 bg-card/50 p-6">
            <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-muted-foreground">
              Trace Context Headers
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/50 text-left">
                    <th className="pb-3 font-medium text-muted-foreground">Header</th>
                    <th className="pb-3 font-medium text-muted-foreground">Format</th>
                    <th className="pb-3 font-medium text-muted-foreground">Purpose</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-xs">
                  <tr className="border-b border-border/30">
                    <td className="py-3 text-primary">X-Trace-Flow-Api-Key</td>
                    <td className="py-3 text-muted-foreground">string</td>
                    <td className="py-3 text-foreground">Required. Your Trace Flow API key.</td>
                  </tr>
                  <tr className="border-b border-border/30">
                    <td className="py-3 text-primary">X-Trace-Flow-Trace-Id</td>
                    <td className="py-3 text-muted-foreground">32 hex chars</td>
                    <td className="py-3 text-foreground">Optional. Join an existing trace.</td>
                  </tr>
                  <tr>
                    <td className="py-3 text-primary">X-Trace-Flow-Parent-Span-Id</td>
                    <td className="py-3 text-muted-foreground">16 hex chars</td>
                    <td className="py-3 text-foreground">
                      Optional. Set the parent span for hierarchy.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>

      {/* Next Steps */}
      <div className="mt-16 animate-fade-in" style={{ animationDelay: '350ms' }}>
        <h2 className="mb-6 text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Next Steps
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Link href="/docs/sdk-reference" className="group">
            <div className="relative flex h-full flex-col rounded-xl border border-border/50 bg-card/50 p-6 transition-all duration-200 hover:border-primary/30 hover:bg-card">
              <div className="absolute -inset-px rounded-xl bg-gradient-to-b from-primary/10 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
              <div className="relative">
                <h3 className="mb-2 text-lg font-semibold text-foreground">SDK Reference</h3>
                <p className="text-sm text-muted-foreground">
                  Examples for OpenAI, Anthropic, OpenRouter, Groq, and native SDKs.
                </p>
              </div>
            </div>
          </Link>
          <Link href="/docs/opentelemetry" className="group">
            <div className="relative flex h-full flex-col rounded-xl border border-border/50 bg-card/50 p-6 transition-all duration-200 hover:border-primary/30 hover:bg-card">
              <div className="absolute -inset-px rounded-xl bg-gradient-to-b from-primary/10 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
              <div className="relative">
                <h3 className="mb-2 text-lg font-semibold text-foreground">OpenTelemetry Setup</h3>
                <p className="text-sm text-muted-foreground">
                  Set up your own tracer for custom spans, events, and attributes.
                </p>
              </div>
            </div>
          </Link>
        </div>
      </div>
    </>
  );
}
