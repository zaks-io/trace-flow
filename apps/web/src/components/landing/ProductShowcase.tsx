import { Check, Route, SquareTerminal } from 'lucide-react';

const REQUEST_ROWS = [
  {
    provider: 'Anthropic',
    model: 'claude-opus-4-7',
    tokens: '18.2k',
    latency: '4.8s',
    cost: '$0.42',
  },
  { provider: 'OpenAI', model: 'gpt-5.5', tokens: '9.7k', latency: '2.1s', cost: '$0.18' },
  { provider: 'Google', model: 'gemini-2.5-pro', tokens: '22.4k', latency: '3.6s', cost: '$0.11' },
  { provider: 'OpenRouter', model: 'qwen3-coder', tokens: '31.8k', latency: '6.2s', cost: '$0.09' },
] as const;

const PROVIDER_DOT_COLORS = ['bg-chart-1', 'bg-chart-4', 'bg-chart-3', 'bg-chart-5'] as const;

export function ProductShowcase() {
  return (
    <section id="product" className="relative border-y border-border/70 bg-card/20 py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <div className="mb-14 max-w-3xl">
          <h2 className="text-balance text-3xl font-semibold tracking-[-0.035em] text-foreground sm:text-5xl">
            Two sources of spend. One account.
          </h2>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-muted-foreground">
            Use either path or both. Each one records estimated cost, tokens, and failures you can
            filter by model and source.
          </p>
        </div>

        <div className="grid gap-5 lg:grid-cols-12">
          <article className="rounded-xl border border-primary/25 bg-primary/4 p-6 sm:p-8 lg:col-span-5">
            <SourceHeading
              icon={<SquareTerminal className="size-4" strokeWidth={1.75} />}
              label="Coding agents"
              badge="Alpha"
            />
            <h3 className="mt-4 text-xl font-semibold tracking-tight sm:text-2xl">
              Find the sessions worth a closer look
            </h3>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              The desktop app reads Claude Code and Codex CLI history, plus Cursor on macOS. It
              parses sessions on your machine and uploads analytics, not transcripts.
            </p>
            <ul className="mt-8 space-y-5">
              <Capability
                label="Cost and context by conversation depth"
                detail="See how context and estimated cost grow through a session."
              />
              <Capability
                label="Tool reliability"
                detail="Compare failure rates by source, model, or repository."
              />
              <Capability
                label="Review and file attention"
                detail="Connect agent spend to the code and reviews it touched."
              />
            </ul>
          </article>

          <article className="overflow-hidden rounded-xl border border-border bg-background lg:col-span-7">
            <div className="p-6 sm:p-8">
              <SourceHeading
                icon={<Route className="size-4" strokeWidth={1.75} />}
                label="API calls"
              />
              <h3 className="mt-4 text-xl font-semibold tracking-tight sm:text-2xl">
                Every model request, priced
              </h3>
              <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
                Route your SDK through the Trace Flow gateway. Responses keep streaming while each
                request records cost, tokens, latency, and errors.
              </p>
            </div>
            <div className="px-3 pb-3 sm:px-5 sm:pb-5">
              <div className="overflow-hidden rounded-lg border border-border bg-card/45">
                <div className="grid grid-cols-[1fr_0.7fr_0.6fr] border-b border-border px-3 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground sm:grid-cols-[0.8fr_1.35fr_0.55fr_0.55fr_0.5fr]">
                  <span>Provider</span>
                  <span className="hidden sm:block">Model</span>
                  <span>Tokens</span>
                  <span className="hidden sm:block">Latency</span>
                  <span className="text-right">Cost</span>
                </div>
                {REQUEST_ROWS.map((row, index) => (
                  <div
                    key={row.model}
                    className="grid grid-cols-[1fr_0.7fr_0.6fr] items-center border-border/60 px-3 py-3 text-xs not-last:border-b sm:grid-cols-[0.8fr_1.35fr_0.55fr_0.55fr_0.5fr]"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${PROVIDER_DOT_COLORS[index]}`}
                        aria-hidden="true"
                      />
                      <span className="text-foreground">{row.provider}</span>
                    </span>
                    <span className="hidden truncate font-mono text-muted-foreground sm:block">
                      {row.model}
                    </span>
                    <span className="font-mono text-muted-foreground">{row.tokens}</span>
                    <span className="hidden font-mono text-muted-foreground sm:block">
                      {row.latency}
                    </span>
                    <span className="text-right font-mono text-foreground">{row.cost}</span>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs text-muted-foreground">Illustrative request data</p>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

function SourceHeading({
  icon,
  label,
  badge,
}: {
  icon: React.ReactNode;
  label: string;
  badge?: string;
}) {
  return (
    <div className="flex items-center gap-2.5 text-sm font-medium text-foreground">
      <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
        {icon}
      </span>
      {label}
      {badge && (
        <span className="rounded-full border border-primary/30 px-2 py-0.5 text-[11px] font-medium text-primary">
          {badge}
        </span>
      )}
    </div>
  );
}

function Capability({ label, detail }: { label: string; detail: string }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-primary/30 text-primary">
        <Check className="size-3" strokeWidth={2} aria-hidden="true" />
      </span>
      <div>
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="mt-1 text-sm leading-6 text-muted-foreground">{detail}</div>
      </div>
    </li>
  );
}
