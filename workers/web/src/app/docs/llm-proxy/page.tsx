'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { ArrowLeft, Copy, Check, Terminal, Webhook, BookOpen, Zap } from 'lucide-react';
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

// Vercel AI SDK examples
const VERCEL_AI_OPENAI_CODE = `import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

const openai = createOpenAI({
  baseURL: "https://your-proxy.workers.dev/openai/v1",
  apiKey: process.env.OPENAI_API_KEY,
  headers: {
    "X-Observe-Api-Key": process.env.OBSERVE_API_KEY,
  },
});

const result = await generateText({
  model: openai("gpt-4o"),
  prompt: "Hello, world!",
});`;

const VERCEL_AI_ANTHROPIC_CODE = `import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";

const anthropic = createAnthropic({
  baseURL: "https://your-proxy.workers.dev/anthropic/v1",
  apiKey: process.env.ANTHROPIC_API_KEY,
  headers: {
    "X-Observe-Api-Key": process.env.OBSERVE_API_KEY,
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
  baseURL: "https://your-proxy.workers.dev/openrouter/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  headers: {
    "X-Observe-Api-Key": process.env.OBSERVE_API_KEY,
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
  baseURL: "https://your-proxy.workers.dev/groq/v1",
  apiKey: process.env.GROQ_API_KEY,
  headers: {
    "X-Observe-Api-Key": process.env.OBSERVE_API_KEY,
  },
});

const result = await generateText({
  model: groq("llama-3.3-70b-versatile"),
  prompt: "Hello, world!",
});`;

// OpenAI SDK example
const OPENAI_SDK_CODE = `import OpenAI from "openai";

const openai = new OpenAI({
  baseURL: "https://your-proxy.workers.dev/openai/v1",
  apiKey: process.env.OPENAI_API_KEY,
  defaultHeaders: {
    "X-Observe-Api-Key": process.env.OBSERVE_API_KEY,
  },
});

const completion = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello, world!" }],
});

console.log(completion.choices[0].message.content);`;

const CURL_CODE = `curl -X POST https://your-proxy.workers.dev/openai/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $OPENAI_API_KEY" \\
  -H "X-Observe-Api-Key: $OBSERVE_API_KEY" \\
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`;

const ROUTES = [
  {
    provider: 'OpenAI',
    path: '/openai/v1/chat/completions',
    target: 'https://api.openai.com/v1/chat/completions',
  },
  {
    provider: 'Anthropic',
    path: '/anthropic/v1/messages',
    target: 'https://api.anthropic.com/v1/messages',
  },
  {
    provider: 'OpenRouter',
    path: '/openrouter/v1/chat/completions',
    target: 'https://openrouter.ai/api/v1/chat/completions',
  },
  {
    provider: 'Groq',
    path: '/groq/v1/chat/completions',
    target: 'https://api.groq.com/openai/v1/chat/completions',
  },
];

export default function LLMProxyDocsPage() {
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
        <div className="mb-16 animate-fade-in">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1">
            <Webhook className="h-3.5 w-3.5 text-primary" />
            <span className="font-mono text-xs text-primary">LLM Proxy</span>
          </div>
          <h1 className="mb-4 text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
            LLM Proxy Gateway
          </h1>
          <p className="max-w-2xl text-lg text-muted-foreground">
            Route LLM requests through the Observe proxy for automatic tracing and analytics. Works
            with any OpenAI-compatible client or the Vercel AI SDK.
          </p>
        </div>

        {/* Route table */}
        <div className="mb-16 animate-fade-in" style={{ animationDelay: '100ms' }}>
          <div className="rounded-xl border border-border/50 bg-card/50 p-6">
            <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-muted-foreground">
              Proxy Routes
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/50 text-left">
                    <th className="pb-3 font-medium text-muted-foreground">Provider</th>
                    <th className="pb-3 font-medium text-muted-foreground">Gateway Path</th>
                    <th className="pb-3 font-medium text-muted-foreground">Target URL</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-xs">
                  {ROUTES.map((route) => (
                    <tr key={route.provider} className="border-b border-border/30 last:border-0">
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
              Authentication
            </h3>
            <p className="mb-4 text-sm text-foreground">All requests require two headers:</p>
            <ul className="space-y-2 text-sm text-foreground">
              <li className="flex items-start gap-3">
                <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                <span>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    X-Observe-Api-Key
                  </code>{' '}
                  — Your Observe API key for tracing
                </span>
              </li>
              <li className="flex items-start gap-3">
                <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                <span>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    Authorization
                  </code>{' '}
                  — Your provider API key (passed through to the upstream)
                </span>
              </li>
            </ul>
          </div>
        </div>

        {/* OpenAI SDK Section */}
        <div className="mb-16 animate-fade-in" style={{ animationDelay: '200ms' }}>
          <h2 className="mb-6 text-sm font-medium uppercase tracking-wider text-muted-foreground">
            OpenAI SDK
          </h2>
          <p className="mb-6 text-muted-foreground">
            Use the official{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm text-foreground">
              openai
            </code>{' '}
            npm package with a custom base URL. This works with any OpenAI-compatible provider.
          </p>
          <CodeBlock code={OPENAI_SDK_CODE} language="typescript" />
        </div>

        {/* Vercel AI SDK Section */}
        <div className="space-y-16">
          <div>
            <h2 className="mb-6 text-sm font-medium uppercase tracking-wider text-muted-foreground">
              Vercel AI SDK
            </h2>
            <p className="mb-6 text-muted-foreground">
              The{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm text-foreground">
                ai
              </code>{' '}
              package from Vercel provides a unified interface for multiple providers. Each provider
              has its own SDK package.
            </p>
          </div>

          {/* OpenAI with Vercel AI */}
          <SectionCard icon={Zap} title="OpenAI (@ai-sdk/openai)" className="animate-fade-in">
            <CodeBlock code={VERCEL_AI_OPENAI_CODE} language="typescript" />
          </SectionCard>

          {/* Anthropic with Vercel AI */}
          <SectionCard icon={Zap} title="Anthropic (@ai-sdk/anthropic)" className="animate-fade-in">
            <CodeBlock code={VERCEL_AI_ANTHROPIC_CODE} language="typescript" />
          </SectionCard>

          {/* OpenRouter with Vercel AI */}
          <SectionCard icon={Zap} title="OpenRouter (@ai-sdk/openai)" className="animate-fade-in">
            <p className="mb-4 text-muted-foreground">
              OpenRouter uses an OpenAI-compatible API, so use the{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm text-foreground">
                @ai-sdk/openai
              </code>{' '}
              package with a different base URL.
            </p>
            <CodeBlock code={VERCEL_AI_OPENROUTER_CODE} language="typescript" />
          </SectionCard>

          {/* Groq with Vercel AI */}
          <SectionCard icon={Zap} title="Groq (@ai-sdk/openai)" className="animate-fade-in">
            <p className="mb-4 text-muted-foreground">Groq also uses an OpenAI-compatible API.</p>
            <CodeBlock code={VERCEL_AI_GROQ_CODE} language="typescript" />
          </SectionCard>
        </div>

        {/* cURL Section */}
        <div className="mt-16 animate-fade-in">
          <h2 className="mb-6 text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Direct HTTP
          </h2>
          <SectionCard icon={Terminal} title="cURL Example" className="animate-fade-in">
            <p className="mb-4 text-muted-foreground">
              You can also use the proxy directly with cURL or any HTTP client:
            </p>
            <CodeBlock code={CURL_CODE} language="bash" />
          </SectionCard>
        </div>

        {/* What gets tracked */}
        <div className="mt-20 animate-fade-in">
          <div className="rounded-xl border border-border/50 bg-card/50 p-6">
            <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-muted-foreground">
              What Gets Tracked
            </h3>
            <ul className="space-y-3 text-sm text-foreground">
              <li className="flex items-start gap-3">
                <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                <span>Request and response bodies stored in R2</span>
              </li>
              <li className="flex items-start gap-3">
                <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                <span>Token usage (input, output, cached, reasoning)</span>
              </li>
              <li className="flex items-start gap-3">
                <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                <span>Timing metrics (total latency, time to first token for streams)</span>
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
