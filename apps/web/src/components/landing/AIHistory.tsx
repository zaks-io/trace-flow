import Link from 'next/link';

export function AIHistory() {
  return (
    <section className="relative border-b border-border/70 bg-card/20 py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <div className="mb-12 max-w-3xl">
          <div className="mb-4 font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-primary">
            Today
          </div>
          <h2 className="text-balance text-3xl font-semibold tracking-[-0.035em] text-foreground sm:text-5xl">
            Analytics today.
          </h2>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">
            Trace Flow keeps analytics from coding sessions and model calls so you can investigate
            costs and performance over time.
          </p>
        </div>

        <div className="grid gap-5">
          <article className="rounded-xl border border-border bg-background p-6 sm:p-8">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-primary">
              Available today
            </div>
            <h3 className="mt-3 text-xl font-semibold tracking-tight sm:text-2xl">
              Cost and performance history
            </h3>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              Keep cost and usage trends you can revisit as your tools and habits change. Monthly
              model usage totals are retained for five years; coding-agent analytics for one year.
              Individual model traces have shorter, plan-based access windows.
            </p>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              Filter analytics in the dashboard or query them through MCP. Coding-session capture
              includes redacted excerpts for investigation; it does not upload full transcripts.
            </p>
            <Link
              href="/privacy"
              className="mt-5 inline-block text-sm font-medium text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-primary"
            >
              Read the retention policy
            </Link>
          </article>
        </div>
      </div>
    </section>
  );
}
