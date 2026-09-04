'use client';

import { KeyRound, TerminalSquare } from 'lucide-react';
import { CopyCodeButton } from '@/components/docs/CopyCodeButton';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type ApiKeyQuickStartProps = {
  apiKey: string | null;
  title?: string;
  description?: string;
  statusMessage?: string | null;
};

function SnippetCard({
  title,
  description,
  code,
}: {
  title: string;
  description: string;
  code: string;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/80 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-foreground">{title}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <CopyCodeButton code={code} />
      </div>
      <pre className="overflow-x-auto rounded-lg bg-muted/50 p-3 text-xs text-foreground">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function ApiKeyQuickStart({
  apiKey,
  title = 'Your Trace Flow API key',
  description = 'Trace Flow generated a default key for you. Copy it into your environment, then hand off the setup prompt to your coding agent.',
  statusMessage,
}: ApiKeyQuickStartProps) {
  const shellSnippet = apiKey
    ? `export TRACE_FLOW_API_KEY="${apiKey}"`
    : 'Generating your default API key...';

  const envFileSnippet = apiKey
    ? `TRACE_FLOW_API_KEY=${apiKey}\nOPENAI_API_KEY=your-provider-key\nOPENAI_MODEL=your-openai-model`
    : 'TRACE_FLOW_API_KEY=...';

  return (
    <Card className="border-primary/20 bg-card/80">
      <CardHeader>
        <div className="flex items-center gap-2 text-primary">
          <KeyRound className="h-4 w-4" />
          <span className="text-xs font-medium uppercase tracking-[0.2em]">Step 1</span>
        </div>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-xl border border-border/60 bg-background/80 p-4">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-foreground">Default key</p>
              <p className="text-xs text-muted-foreground">
                This is the key your app or agent should use when sending traffic through Trace
                Flow.
              </p>
            </div>
            {apiKey ? <CopyCodeButton code={apiKey} /> : null}
          </div>
          <div className="rounded-lg bg-muted/50 p-3">
            <code className="break-all text-xs text-foreground">
              {apiKey ?? 'Preparing key...'}
            </code>
          </div>
          {statusMessage ? (
            <p className="mt-3 text-xs text-muted-foreground">{statusMessage}</p>
          ) : null}
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <SnippetCard
            title="Shell export"
            description="Use this in your terminal before running your app locally."
            code={shellSnippet}
          />
          <SnippetCard
            title=".env.local"
            description="Use this in local env files your app already loads."
            code={envFileSnippet}
          />
        </div>

        <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/70 px-3 py-2 text-xs text-muted-foreground">
          <TerminalSquare className="h-3.5 w-3.5" />
          <span>
            Trace Flow does not replace your provider key. Keep `OPENAI_API_KEY` or the equivalent
            provider env var set as usual.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
