import Link from 'next/link';
import { CodeBlock } from '@/components/docs/CodeBlock';
import { ExternalLink, Code, Terminal, Zap, Globe } from 'lucide-react';

const VERCEL_AI_OPENAI_CODE = `import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

const openai = createOpenAI({
  baseURL: "https://gateway.trace-flow.dev/openai/v1",
  apiKey: process.env.OPENAI_API_KEY,
  headers: {
    "X-Trace-Flow-Api-Key": process.env.TRACE_FLOW_API_KEY,
  },
});

const result = await generateText({
  model: openai("gpt-5"),
  prompt: "Hello, world!",
});`;

const VERCEL_AI_ANTHROPIC_CODE = `import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";

const anthropic = createAnthropic({
  baseURL: "https://gateway.trace-flow.dev/anthropic/v1",
  apiKey: process.env.ANTHROPIC_API_KEY,
  headers: {
    "X-Trace-Flow-Api-Key": process.env.TRACE_FLOW_API_KEY,
  },
});

const result = await generateText({
  model: anthropic("claude-sonnet-4-20250514"),
  prompt: "Hello, world!",
});`;

const VERCEL_AI_OPENROUTER_CODE = `import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

// OpenRouter uses the OpenAI-compatible provider
const openrouter = createOpenAI({
  baseURL: "https://gateway.trace-flow.dev/openrouter/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  headers: {
    "X-Trace-Flow-Api-Key": process.env.TRACE_FLOW_API_KEY,
  },
});

const result = await generateText({
  model: openrouter("anthropic/claude-sonnet-4"),
  prompt: "Hello, world!",
});`;

const VERCEL_AI_GROQ_CODE = `import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

// Groq uses the OpenAI-compatible provider
const groq = createOpenAI({
  baseURL: "https://gateway.trace-flow.dev/groq/v1",
  apiKey: process.env.GROQ_API_KEY,
  headers: {
    "X-Trace-Flow-Api-Key": process.env.TRACE_FLOW_API_KEY,
  },
});

const result = await generateText({
  model: groq("llama-3.3-70b-versatile"),
  prompt: "Hello, world!",
});`;

const OPENAI_SDK_CODE = `import OpenAI from "openai";

const openai = new OpenAI({
  baseURL: "https://gateway.trace-flow.dev/openai/v1",
  apiKey: process.env.OPENAI_API_KEY,
  defaultHeaders: {
    "X-Trace-Flow-Api-Key": process.env.TRACE_FLOW_API_KEY,
  },
});

const completion = await openai.chat.completions.create({
  model: "gpt-5",
  messages: [{ role: "user", content: "Hello, world!" }],
});

console.log(completion.choices[0].message.content);`;

const CURL_CODE = `curl -X POST https://gateway.trace-flow.dev/openai/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $OPENAI_API_KEY" \\
  -H "X-Trace-Flow-Api-Key: $TRACE_FLOW_API_KEY" \\
  -d '{
    "model": "gpt-5",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`;

const WITH_TRACE_CONTEXT_CODE = `const result = await generateText({
  model: openai("gpt-5"),
  prompt: "Hello!",
  headers: {
    "X-Trace-Flow-Trace-Id": traceId,      // 32 hex chars
    "X-Trace-Flow-Parent-Span-Id": spanId, // 16 hex chars
  },
});`;

const ROUTES = [
  { provider: 'OpenAI', path: '/openai/v1/*', target: 'api.openai.com/v1/*' },
  { provider: 'Anthropic', path: '/anthropic/v1/*', target: 'api.anthropic.com/v1/*' },
  { provider: 'OpenRouter', path: '/openrouter/v1/*', target: 'openrouter.ai/api/v1/*' },
  { provider: 'Groq', path: '/groq/v1/*', target: 'api.groq.com/openai/v1/*' },
];

export default function SDKReferencePage() {
  return (
    <>
      {/* Hero */}
      <div className="mb-16 animate-fade-in">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1">
          <ExternalLink className="h-3.5 w-3.5 text-primary" />
          <span className="font-mono text-xs text-primary">SDK Reference</span>
        </div>
        <h1 className="mb-4 text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
          Provider Examples
        </h1>
        <p className="max-w-2xl text-lg text-muted-foreground">
          Copy-paste examples for every supported provider. Works with Vercel AI SDK, native SDKs,
          and direct HTTP.
        </p>
      </div>

      {/* Proxy Routes Table */}
      <div className="mb-16 animate-fade-in" style={{ animationDelay: '100ms' }}>
        <div className="rounded-xl border border-border/50 bg-card/50 p-6">
          <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Gateway Routes
          </h3>
          <p className="mb-4 text-sm text-muted-foreground">
            All requests go through{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
              https://gateway.trace-flow.dev
            </code>
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 text-left">
                  <th className="pb-3 font-medium text-muted-foreground">Provider</th>
                  <th className="pb-3 font-medium text-muted-foreground">Gateway Path</th>
                  <th className="pb-3 font-medium text-muted-foreground">Proxies To</th>
                </tr>
              </thead>
              <tbody className="font-mono text-xs">
                {ROUTES.map((route, i) => (
                  <tr key={i} className="border-b border-border/30 last:border-0">
                    <td className="py-3 text-foreground">{route.provider}</td>
                    <td className="py-3 text-primary">{route.path}</td>
                    <td className="py-3 text-muted-foreground">{route.target}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Authentication */}
      <div className="mb-16 animate-fade-in" style={{ animationDelay: '150ms' }}>
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-6">
          <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-primary">
            Required Headers
          </h3>
          <ul className="space-y-2 text-sm text-foreground">
            <li className="flex items-start gap-3">
              <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  X-Trace-Flow-Api-Key
                </code>{' '}
                — Your{' '}
                <Link href="/app/api-keys" className="text-primary hover:underline">
                  Trace Flow API key
                </Link>
              </span>
            </li>
            <li className="flex items-start gap-3">
              <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  Authorization
                </code>{' '}
                — Your provider API key (passed through to upstream)
              </span>
            </li>
          </ul>
        </div>
      </div>

      {/* Vercel AI SDK Section */}
      <div className="space-y-12">
        <div className="animate-fade-in" style={{ animationDelay: '200ms' }}>
          <h2 className="mb-6 text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Vercel AI SDK
          </h2>
          <p className="mb-8 text-muted-foreground">
            The{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm text-foreground">
              ai
            </code>{' '}
            package provides a unified interface for all providers.
          </p>
        </div>

        {/* OpenAI */}
        <section className="animate-fade-in">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[oklch(0.5_0.0_0)]/10 text-foreground">
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
              </svg>
            </div>
            <h3 className="text-xl font-semibold tracking-tight text-foreground">OpenAI</h3>
            <span className="rounded-full border border-border/50 bg-muted/30 px-2 py-0.5 font-mono text-xs text-muted-foreground">
              @ai-sdk/openai
            </span>
          </div>
          <CodeBlock code={VERCEL_AI_OPENAI_CODE} lang="typescript" />
        </section>

        {/* Anthropic */}
        <section className="animate-fade-in">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[oklch(0.75_0.12_50)]/10 text-[oklch(0.75_0.12_50)]">
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm3.174 3.662L6.53 13.641h6.441l-3.228-6.46z" />
              </svg>
            </div>
            <h3 className="text-xl font-semibold tracking-tight text-foreground">Anthropic</h3>
            <span className="rounded-full border border-border/50 bg-muted/30 px-2 py-0.5 font-mono text-xs text-muted-foreground">
              @ai-sdk/anthropic
            </span>
          </div>
          <CodeBlock code={VERCEL_AI_ANTHROPIC_CODE} lang="typescript" />
        </section>

        {/* OpenRouter */}
        <section className="animate-fade-in">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[oklch(0.7_0.15_262)]/10 text-[oklch(0.7_0.15_262)]">
              <Globe className="h-5 w-5" />
            </div>
            <h3 className="text-xl font-semibold tracking-tight text-foreground">OpenRouter</h3>
            <span className="rounded-full border border-border/50 bg-muted/30 px-2 py-0.5 font-mono text-xs text-muted-foreground">
              @ai-sdk/openai
            </span>
          </div>
          <p className="mb-4 text-sm text-muted-foreground">
            OpenRouter uses an OpenAI-compatible API, so use the{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
              @ai-sdk/openai
            </code>{' '}
            package.
          </p>
          <CodeBlock code={VERCEL_AI_OPENROUTER_CODE} lang="typescript" />
        </section>

        {/* Groq */}
        <section className="animate-fade-in">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[oklch(0.7_0.18_145)]/10 text-[oklch(0.7_0.18_145)]">
              <Zap className="h-5 w-5" />
            </div>
            <h3 className="text-xl font-semibold tracking-tight text-foreground">Groq</h3>
            <span className="rounded-full border border-border/50 bg-muted/30 px-2 py-0.5 font-mono text-xs text-muted-foreground">
              @ai-sdk/openai
            </span>
          </div>
          <p className="mb-4 text-sm text-muted-foreground">
            Groq also uses an OpenAI-compatible API.
          </p>
          <CodeBlock code={VERCEL_AI_GROQ_CODE} lang="typescript" />
        </section>
      </div>

      {/* Native SDKs */}
      <div className="mt-16 space-y-12">
        <div className="animate-fade-in">
          <h2 className="mb-6 text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Native SDKs
          </h2>
        </div>

        <section className="animate-fade-in">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Code className="h-5 w-5" />
            </div>
            <h3 className="text-xl font-semibold tracking-tight text-foreground">OpenAI SDK</h3>
            <span className="rounded-full border border-border/50 bg-muted/30 px-2 py-0.5 font-mono text-xs text-muted-foreground">
              openai
            </span>
          </div>
          <p className="mb-4 text-sm text-muted-foreground">
            The official{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
              openai
            </code>{' '}
            npm package works with any OpenAI-compatible provider.
          </p>
          <CodeBlock code={OPENAI_SDK_CODE} lang="typescript" />
        </section>
      </div>

      {/* Direct HTTP */}
      <div className="mt-16 space-y-12">
        <div className="animate-fade-in">
          <h2 className="mb-6 text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Direct HTTP
          </h2>
        </div>

        <section className="animate-fade-in">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Terminal className="h-5 w-5" />
            </div>
            <h3 className="text-xl font-semibold tracking-tight text-foreground">cURL</h3>
          </div>
          <CodeBlock code={CURL_CODE} lang="bash" />
        </section>
      </div>

      {/* Adding Trace Context */}
      <div className="mt-16 animate-fade-in">
        <div className="rounded-xl border border-border/50 bg-card/50 p-6">
          <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Linking to OpenTelemetry Traces
          </h3>
          <p className="mb-4 text-sm text-muted-foreground">
            Add trace context headers to connect LLM calls to your existing traces. See the{' '}
            <Link href="/docs/quick-start" className="text-primary hover:underline">
              Quick Start
            </Link>{' '}
            or{' '}
            <Link href="/docs/opentelemetry" className="text-primary hover:underline">
              OpenTelemetry guide
            </Link>{' '}
            for full setup.
          </p>
          <CodeBlock code={WITH_TRACE_CONTEXT_CODE} lang="typescript" />
        </div>
      </div>

      {/* What Gets Tracked */}
      <div className="mt-16 animate-fade-in">
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-6">
          <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-primary">
            What Gets Tracked
          </h3>
          <ul className="space-y-2 text-sm text-foreground">
            <li className="flex items-start gap-3">
              <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span>Request and response bodies</span>
            </li>
            <li className="flex items-start gap-3">
              <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span>Token usage (input, output, cached, reasoning)</span>
            </li>
            <li className="flex items-start gap-3">
              <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span>Timing metrics (latency, time to first token)</span>
            </li>
            <li className="flex items-start gap-3">
              <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span>Model, provider, and finish reason</span>
            </li>
            <li className="flex items-start gap-3">
              <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span>Error details when requests fail</span>
            </li>
          </ul>
        </div>
      </div>
    </>
  );
}
