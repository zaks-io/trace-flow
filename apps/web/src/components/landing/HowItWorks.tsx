const STEPS = [
  {
    step: '1',
    title: 'Capture at the right boundary',
    description:
      'Route model calls through the edge proxy. Private testers can also connect local Claude Code, Codex CLI, and macOS Cursor sessions.',
  },
  {
    step: '2',
    title: 'Keep the work moving',
    description:
      'Responses keep streaming while traces, costs, and redacted agent facts are processed off the response path.',
  },
  {
    step: '3',
    title: 'Investigate the pattern',
    description:
      'Filter by provider, model, source, or repository. Compare changes across request and session views.',
  },
];

export function HowItWorks() {
  return (
    <section className="relative bg-background py-24 sm:py-32">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-border to-transparent" />
      <div className="mx-auto max-w-5xl px-6">
        <div className="mb-16 text-center">
          <div className="mb-4 font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-primary">
            The signal path
          </div>
          <h2 className="mb-4 text-3xl font-semibold tracking-[-0.035em] text-foreground sm:text-5xl">
            Observe the work without getting in its way.
          </h2>
          <p className="mx-auto max-w-2xl text-lg leading-8 text-muted-foreground">
            Trace Flow keeps collection separate from the product path, then gives every signal the
            same place to land.
          </p>
        </div>

        <div className="relative grid gap-12 sm:grid-cols-3 sm:gap-8">
          {/* Connecting line */}
          <div className="pointer-events-none absolute top-5 right-[calc(16.67%+1rem)] left-[calc(16.67%+1rem)] hidden h-px bg-linear-to-r from-primary/20 via-primary/40 to-primary/20 sm:block" />

          {STEPS.map(({ step, title, description }) => (
            <div key={step} className="relative text-center">
              <div className="relative mx-auto mb-5 flex h-10 w-10 items-center justify-center rounded-full border border-primary/30 bg-primary/10 font-mono text-sm font-bold text-primary">
                <div className="absolute inset-0 rounded-full bg-primary/5" />
                <span className="relative">{step}</span>
              </div>
              <h3 className="mb-2 text-sm font-semibold text-foreground">{title}</h3>
              <p className="text-sm leading-6 text-muted-foreground">{description}</p>
            </div>
          ))}
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-linear-to-r from-transparent via-border to-transparent" />
    </section>
  );
}
