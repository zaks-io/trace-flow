import Link from 'next/link';

export function AIHistory() {
  return (
    <section className="relative border-b border-border/70 bg-card/20 py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <div className="mb-12 max-w-3xl">
          <div className="mb-4 font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-primary">
            Why keep the data?
          </div>
          <h2 className="text-balance text-3xl font-semibold tracking-[-0.035em] text-foreground sm:text-5xl">
            Your AI work is worth learning from.
          </h2>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">
            A session ends, but the questions remain. Why did it cost so much? Where did the agent
            get stuck? Did a model change help? Trace Flow starts by collecting the history you need
            to investigate.
          </p>
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          <article className="rounded-xl border border-border bg-background p-6 sm:p-8">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-primary">
              In the alpha
            </div>
            <h3 className="mt-3 text-xl font-semibold tracking-tight sm:text-2xl">
              A history beyond the current session
            </h3>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              Keep cost and usage trends you can revisit as your tools and habits change. Monthly
              model usage totals are retained for five years; coding-agent analytics for one year.
              Individual model traces have shorter, plan-based access windows.
            </p>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              Search and filter analytics in the dashboard, or query them through MCP to bring that
              history into your own investigations.
            </p>
            <Link
              href="/privacy"
              className="mt-5 inline-block text-sm font-medium text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-primary"
            >
              Read the retention policy
            </Link>
          </article>

          <article className="rounded-xl border border-primary/25 bg-primary/4 p-6 sm:p-8">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-primary">
              In development
            </div>
            <h3 className="mt-3 text-xl font-semibold tracking-tight sm:text-2xl">
              Preserve the conversations themselves
            </h3>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              We&apos;re building an opt-in archive of full agent conversations. The goal is to keep
              your own record of the work, including the exchanges behind the metrics, so you can
              return to it for deeper analysis and future training datasets.
            </p>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              Full conversation archiving and search are not available in the alpha yet.
            </p>
          </article>
        </div>

        <div className="mt-12 max-w-3xl">
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-primary">
            Planned research
          </div>
          <h3 className="mt-3 text-xl font-semibold tracking-tight sm:text-2xl">
            Trace Flow Analyst
          </h3>
          <p className="mt-4 text-sm leading-6 text-muted-foreground">
            Next, we want to search across captured conversations and analyze where agents get
            stuck, repeat failed approaches, or waste time and tokens. Trace Flow Analyst is
            planned, not built. Longer term, we want to explore how this record can support
            fine-tuning and alignment research into how agents behave across many conversations.
          </p>
        </div>
      </div>
    </section>
  );
}
