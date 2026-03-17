'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Bot, BookOpen, CheckCircle2, ExternalLink, Loader2, PlayCircle } from 'lucide-react';
import { CopyCodeButton } from '@/components/docs/CopyCodeButton';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiKeyQuickStart } from './ApiKeyQuickStart';

type GettingStartedProps = {
  apiKey: string | null;
  isPreparingApiKey: boolean;
  apiKeyError: string | null;
  isWaitingForFirstTrace: boolean;
};

function buildAgentPrompt(siteUrl: string): string {
  return [
    'Integrate Trace Flow into this repository.',
    `Read ${siteUrl}/agents.md and follow it exactly.`,
    'Use TRACE_FLOW_API_KEY from the project environment or local env files.',
    'Set the provider base URL to the Trace Flow gateway and keep the upstream provider API key configured normally.',
    'After the integration is in place, run one traced request and confirm the first trace appears in the dashboard.',
  ].join('\n');
}

function buildSampleRequestSnippet(): string {
  return [
    "import { createOpenAI } from '@ai-sdk/openai';",
    "import { generateText } from 'ai';",
    '',
    'const openai = createOpenAI({',
    "  baseURL: 'https://gateway.trace-flow.dev/openai/v1',",
    '  apiKey: process.env.OPENAI_API_KEY,',
    '  headers: {',
    "    'X-Trace-Flow-Api-Key': process.env.TRACE_FLOW_API_KEY,",
    '  },',
    '});',
    '',
    'const result = await generateText({',
    "  model: openai('gpt-5'),",
    "  prompt: 'Say hello from Trace Flow.',",
    '});',
    '',
    'console.log(result.text);',
  ].join('\n');
}

function ActionCard({
  step,
  icon,
  title,
  description,
  code,
  href,
  hrefLabel,
}: {
  step: string;
  icon: ReactNode;
  title: string;
  description: string;
  code: string;
  href?: string;
  hrefLabel?: string;
}) {
  return (
    <Card className="border-border/60 bg-card/70">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-primary">
            {icon}
            <span className="text-xs font-medium uppercase tracking-[0.2em]">{step}</span>
          </div>
          <CopyCodeButton code={code} />
        </div>
        <CardTitle className="text-lg">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <pre className="overflow-x-auto rounded-lg bg-background/80 p-4 text-xs text-foreground">
          <code>{code}</code>
        </pre>
        {href && hrefLabel ? (
          <Button asChild variant="outline">
            <Link href={href}>
              <span>{hrefLabel}</span>
              <ExternalLink className="h-4 w-4" />
            </Link>
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function GettingStarted({
  apiKey,
  isPreparingApiKey,
  apiKeyError,
  isWaitingForFirstTrace,
}: GettingStartedProps) {
  const siteUrl = 'https://trace-flow.dev';
  const agentPrompt = buildAgentPrompt(siteUrl);
  const sampleRequestSnippet = buildSampleRequestSnippet();

  let statusMessage: string | null = null;
  if (isPreparingApiKey) {
    statusMessage = 'Generating a default API key for this workspace.';
  } else if (apiKeyError) {
    statusMessage = `We could not create the default key automatically: ${apiKeyError}`;
  } else if (apiKey) {
    statusMessage = 'Copy this once, add it to your local env, and your agent can handle the rest.';
  }

  return (
    <div className="animate-fade-in space-y-8">
      <section className="rounded-2xl border border-primary/20 bg-linear-to-br from-primary/10 via-card to-card p-8">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="max-w-2xl space-y-4">
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.2em] text-primary">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Getting Started
            </div>
            <div className="space-y-2">
              <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                Connect your app before you ever see a chart.
              </h1>
              <p className="max-w-xl text-sm text-muted-foreground sm:text-base">
                Trace Flow is ready when your first real request is ready. We generated a default
                API key for you, and the rest of the flow is just env vars, an agent prompt, and one
                traced request.
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-border/60 bg-background/70 p-4 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">What happens next</p>
            <ol className="mt-2 space-y-1.5">
              <li>1. Copy your Trace Flow API key.</li>
              <li>2. Add `TRACE_FLOW_API_KEY` to your local env.</li>
              <li>3. Hand `/agents.md` to your coding agent.</li>
              <li>4. Run one traced request and watch this page switch to analytics.</li>
            </ol>
          </div>
        </div>
      </section>

      <ApiKeyQuickStart apiKey={apiKey} statusMessage={statusMessage} />

      <div className="grid gap-6 xl:grid-cols-2">
        <ActionCard
          step="Step 2"
          icon={<Bot className="h-4 w-4" />}
          title="Hand off setup to your coding agent"
          description="Copy this prompt into Cursor, Claude Code, or another coding agent. It tells the agent exactly where to fetch the Trace Flow instructions."
          code={agentPrompt}
          href="/agents.md"
          hrefLabel="Open agents.md"
        />

        <ActionCard
          step="Step 3"
          icon={<PlayCircle className="h-4 w-4" />}
          title="Send one traced request"
          description="The fastest v1 path is a single real request with your provider key and the Trace Flow gateway."
          code={sampleRequestSnippet}
          href="/docs/quick-start"
          hrefLabel="Open quick start"
        />
      </div>

      <Card className="border-border/60 bg-card/70">
        <CardHeader>
          <div className="flex items-center gap-2 text-primary">
            <BookOpen className="h-4 w-4" />
            <span className="text-xs font-medium uppercase tracking-[0.2em]">Step 4</span>
          </div>
          <CardTitle>Wait for the first trace</CardTitle>
          <CardDescription>
            As soon as a real request hits the gateway, this page will swap from onboarding to your
            usage dashboard.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 className={`h-4 w-4 ${isWaitingForFirstTrace ? 'animate-spin' : ''}`} />
            <span>
              {isWaitingForFirstTrace
                ? 'Watching for your first traced request...'
                : 'Still no trace yet. Send a request when you are ready.'}
            </span>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button asChild variant="outline">
              <Link href="/docs">
                <span>Read docs</span>
                <ExternalLink className="h-4 w-4" />
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/app/api-keys">Manage API keys</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
