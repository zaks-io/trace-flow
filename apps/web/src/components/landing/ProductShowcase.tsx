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

export function ProductShowcase() {
  return (
    <section id="product" className="relative border-y border-border/70 bg-card/20 py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <div className="mb-16 max-w-3xl">
          <div className="mb-4 font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-primary">
            What you can use today
          </div>
          <h2 className="text-balance text-3xl font-semibold tracking-[-0.035em] text-foreground sm:text-5xl">
            Understand where your time and tokens go.
          </h2>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">
            Compare model costs and response times. See which coding sessions accumulate context or
            run into tool failures. Use the dashboard and analytics tools to investigate what
            changed.
          </p>
        </div>

        <div className="grid gap-5 lg:grid-cols-12">
          <article className="rounded-xl border border-primary/25 bg-primary/4 p-6 sm:p-8 lg:col-span-5">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-primary">
              Coding-agent analytics
            </div>
            <h3 className="mt-3 text-xl font-semibold tracking-tight sm:text-2xl">
              Find the sessions worth investigating
            </h3>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              The desktop app captures analytics from Claude Code and Codex CLI, plus Cursor on
              macOS. Sessions are parsed locally, with redacted excerpts for investigation. Full
              conversation archiving is in development.
            </p>
            <div className="mt-8 space-y-5">
              <Capability
                label="Cost and context by conversation depth"
                detail="See how context and estimated cost grow through a session."
              />
              <Capability
                label="Tool reliability and notable changes"
                detail="Compare failure rates and shifts by source, model, or repository."
              />
              <Capability
                label="Review and file attention"
                detail="Connect agent spend to the code and review units it touched."
              />
            </div>
            <div className="mt-8 rounded-lg border border-primary/20 bg-background/55 p-4">
              <div className="flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <CollectorIcon />
                </span>
                <div>
                  <div className="text-xs font-medium">Desktop app</div>
                  <div className="mt-1 text-[10px] text-muted-foreground">
                    macOS and Windows. Cursor capture on macOS.
                  </div>
                </div>
              </div>
            </div>
          </article>

          <article className="overflow-hidden rounded-xl border border-border bg-background lg:col-span-7">
            <div className="border-b border-border p-6 sm:p-8">
              <div className="mb-5 flex items-center justify-between gap-4">
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-primary">
                    LLM requests
                  </div>
                  <h3 className="mt-2 text-xl font-semibold tracking-tight sm:text-2xl">
                    Track spending and performance over time
                  </h3>
                </div>
              </div>
              <p className="max-w-xl text-sm leading-6 text-muted-foreground">
                Capture estimated costs, token usage, latency, and errors as model responses stream.
                Compare usage over time and inspect captured requests when something goes wrong.
              </p>
            </div>
            <div className="p-3 sm:p-5">
              <div className="overflow-hidden rounded-lg border border-border bg-card/45">
                <div className="grid grid-cols-[1fr_0.65fr_0.65fr] border-b border-border px-3 py-2 font-mono text-[8px] uppercase tracking-[0.12em] text-muted-foreground sm:grid-cols-[0.8fr_1.35fr_0.55fr_0.55fr_0.5fr]">
                  <span>Provider</span>
                  <span className="hidden sm:block">Model</span>
                  <span>Tokens</span>
                  <span className="hidden sm:block">Latency</span>
                  <span className="text-right">Cost</span>
                </div>
                {REQUEST_ROWS.map((row, index) => (
                  <div
                    key={row.model}
                    className={`grid grid-cols-[1fr_0.65fr_0.65fr] items-center px-3 py-3 text-[10px] sm:grid-cols-[0.8fr_1.35fr_0.55fr_0.55fr_0.5fr] ${index < REQUEST_ROWS.length - 1 ? 'border-b border-border/60' : ''}`}
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${['bg-chart-1', 'bg-chart-4', 'bg-chart-3', 'bg-chart-5'][index]}`}
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
              <div className="mt-3 font-mono text-[9px] text-muted-foreground">
                Illustrative request data
              </div>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

function Capability({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="flex gap-3">
      <span className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-primary/30 text-primary">
        <CheckIcon />
      </span>
      <div>
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</div>
      </div>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-3 w-3" aria-hidden="true">
      <path
        d="m5 10 3 3 7-7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function CollectorIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
      <path
        d="M12 3v12m0 0 4-4m-4 4-4-4M5 19h14"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
