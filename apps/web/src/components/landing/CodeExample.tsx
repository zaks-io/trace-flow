'use client';

import { useState } from 'react';

interface ProviderExample {
  name: string;
  before: string;
  after: string;
  highlightLines: number[];
}

const PROVIDERS: ProviderExample[] = [
  {
    name: 'OpenAI',
    before: `import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});`,
    after: `import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: 'https://gateway.trace-flow.dev/openai/v1',
  defaultHeaders: {
    'X-Trace-Flow-Api-Key': process.env.TRACE_FLOW_API_KEY,
  },
});`,
    highlightLines: [4, 5, 6, 7],
  },
  {
    name: 'Anthropic',
    before: `import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});`,
    after: `import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: 'https://gateway.trace-flow.dev/anthropic',
  defaultHeaders: {
    'X-Trace-Flow-Api-Key': process.env.TRACE_FLOW_API_KEY,
  },
});`,
    highlightLines: [4, 5, 6, 7],
  },
  {
    name: 'Google',
    before: `import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});`,
    after: `import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    baseUrl: 'https://gateway.trace-flow.dev/google',
    headers: {
      'X-Trace-Flow-Api-Key': process.env.TRACE_FLOW_API_KEY,
    },
  },
});`,
    highlightLines: [4, 5, 6, 7, 8, 9],
  },
  {
    name: 'OpenRouter',
    before: `import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});`,
    after: `import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://gateway.trace-flow.dev/openrouter/v1',
  defaultHeaders: {
    'X-Trace-Flow-Api-Key': process.env.TRACE_FLOW_API_KEY,
  },
});`,
    highlightLines: [4, 5, 6, 7],
  },
  {
    name: 'Groq',
    before: `import Groq from 'groq-sdk';

const client = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});`,
    after: `import Groq from 'groq-sdk';

const client = new Groq({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://gateway.trace-flow.dev/groq/v1',
  defaultHeaders: {
    'X-Trace-Flow-Api-Key': process.env.TRACE_FLOW_API_KEY,
  },
});`,
    highlightLines: [4, 5, 6, 7],
  },
  {
    name: 'cURL',
    before: `curl https://api.openai.com/v1/chat/completions \\
  -H "Authorization: Bearer $OPENAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "gpt-4o", "messages": [...]}'`,
    after: `curl https://gateway.trace-flow.dev/openai/v1/chat/completions \\
  -H "Authorization: Bearer $OPENAI_API_KEY" \\
  -H "X-Trace-Flow-Api-Key: $TRACE_FLOW_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "gpt-4o", "messages": [...]}'`,
    highlightLines: [0, 2],
  },
];

// Keywords and patterns for syntax coloring
const TOKEN_RULES: [RegExp, string][] = [
  [/^(import|from|const|new)\b/, 'text-[oklch(0.7_0.15_300)]'],
  [/^(curl)\b/, 'text-[oklch(0.75_0.14_75)]'],
  [/^(-[Hd])\b/, 'text-[oklch(0.7_0.15_300)]'],
  [/^("(?:[^"\\]|\\.)*")/, 'text-[oklch(0.72_0.14_150)]'],
  [/^('(?:[^'\\]|\\.)*')/, 'text-[oklch(0.72_0.14_150)]'],
  [/^(\$\w+)/, 'text-[oklch(0.72_0.14_150)]'],
  [/^(process\.env\.\w+)/, 'text-[oklch(0.72_0.14_150)]'],
  [/^(https?:\/\/\S+)/, 'text-foreground underline decoration-muted-foreground/30'],
  [/^(OpenAI|Anthropic|GoogleGenAI|Groq)\b/, 'text-[oklch(0.75_0.14_75)]'],
  [/^(\w+)(?=\s*:)/, 'text-[oklch(0.7_0.12_220)]'],
  [/^([{}();,=])/, 'text-muted-foreground'],
];

function highlightLine(line: string) {
  const tokens: { text: string; className: string }[] = [];
  let remaining = line;

  while (remaining.length > 0) {
    // Try whitespace first
    const wsMatch = remaining.match(/^(\s+)/);
    if (wsMatch) {
      tokens.push({ text: wsMatch[1], className: '' });
      remaining = remaining.slice(wsMatch[1].length);
      continue;
    }

    let matched = false;
    for (const [regex, className] of TOKEN_RULES) {
      const m = remaining.match(regex);
      if (m) {
        tokens.push({ text: m[1], className });
        remaining = remaining.slice(m[1].length);
        matched = true;
        break;
      }
    }

    if (!matched) {
      // Consume one character as plain text
      const nextSpecial = remaining
        .slice(1)
        .search(/[\s'"{}();,=\\$]|import|from|const|new|process\.env|https?:\/\//);
      const end = nextSpecial === -1 ? remaining.length : nextSpecial + 1;
      tokens.push({ text: remaining.slice(0, end), className: 'text-foreground' });
      remaining = remaining.slice(end);
    }
  }

  return tokens;
}

function HighlightedCode({ code, highlightLines }: { code: string; highlightLines?: number[] }) {
  const lines = code.split('\n');
  const highlights = new Set(highlightLines);

  return (
    <pre className="relative overflow-x-auto font-mono text-[13px] leading-relaxed">
      <code>
        {lines.map((line, i) => {
          const tokens = highlightLine(line);
          const isHighlighted = highlights.has(i);
          const lineContent = tokens.map((t, j) =>
            t.className ? (
              <span key={j} className={t.className}>
                {t.text}
              </span>
            ) : (
              t.text
            ),
          );

          return (
            <span key={i}>
              {isHighlighted ? (
                <span className="relative -mx-5 inline-block w-[calc(100%+2.5rem)] bg-primary/7 px-5">
                  {lineContent}
                </span>
              ) : (
                lineContent
              )}
              {i < lines.length - 1 ? '\n' : null}
            </span>
          );
        })}
      </code>
    </pre>
  );
}

function CodeBlock({
  label,
  highlighted,
  children,
}: {
  label: string;
  highlighted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 flex flex-col">
      <div className="mb-2 font-mono text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={`relative flex-1 overflow-hidden rounded-lg border p-5 ${
          highlighted ? 'border-primary/30 bg-primary/3' : 'border-border bg-card/50'
        }`}
      >
        {highlighted && (
          <div className="pointer-events-none absolute inset-0 bg-linear-to-br from-primary/4 to-transparent" />
        )}
        {children}
      </div>
    </div>
  );
}

export function CodeExample() {
  const [activeProvider, setActiveProvider] = useState(0);
  const provider = PROVIDERS[activeProvider];

  return (
    <section className="relative bg-card/30 py-24">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-border to-transparent" />
      <div className="mx-auto max-w-5xl px-6">
        <div className="mb-12 text-center">
          <h2 className="mb-3 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            Keep your SDK. Change the route.
          </h2>
          <p className="text-lg text-muted-foreground">
            The proxy path starts with a base URL and one Trace Flow header.
          </p>
        </div>

        {/* Provider tabs */}
        <div className="mb-6 flex flex-wrap items-center justify-center gap-1.5">
          {PROVIDERS.map((p, i) => (
            <button
              key={p.name}
              onClick={() => setActiveProvider(i)}
              className={`rounded-full px-4 py-1.5 font-mono text-xs transition-all ${
                i === activeProvider
                  ? 'bg-primary/10 text-primary ring-1 ring-primary/20'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {p.name}
            </button>
          ))}
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <CodeBlock label="Before">
            <HighlightedCode code={provider.before} />
          </CodeBlock>
          <CodeBlock label="After" highlighted>
            <HighlightedCode code={provider.after} highlightLines={provider.highlightLines} />
          </CodeBlock>
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-linear-to-r from-transparent via-border to-transparent" />
    </section>
  );
}
