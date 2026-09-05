import Link from 'next/link';

export function AIHistory() {
  return (
    <section className="relative border-b border-border/70 bg-card/20 py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <div className="mb-12 max-w-3xl">
          <div className="mb-4 font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-primary">
            Today and next
          </div>
          <h2 className="text-balance text-3xl font-semibold tracking-[-0.035em] text-foreground sm:text-5xl">
            Analytics today. Conversations next.
          </h2>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">
            Today, Trace Flow keeps analytics from coding sessions and model calls so you can
            investigate costs and performance over time. Full coding-agent conversation storage and
            search are still in development.
          </p>
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
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

          <article className="rounded-xl border border-border bg-background p-6 sm:p-8">
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
              Full conversation archiving and search are not available yet.
            </p>
          </article>
        </div>

        <div className="mt-12 max-w-3xl">
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-primary">
            Planned
          </div>
          <h3 className="mt-3 text-xl font-semibold tracking-tight sm:text-2xl">
            Analyze archived conversations
          </h3>
          <p className="mt-4 text-sm leading-6 text-muted-foreground">
            Trace Flow Analyst lets you ask questions about the analytics you collect today. We plan
            to extend it to archived conversations to investigate repeated failures and wasted time
            or tokens. That archive-based analysis is not available yet. Longer term, we want to
            explore how opt-in archives could support fine-tuning and alignment research.
          </p>
        </div>
      </div>
    </section>
  );
}
