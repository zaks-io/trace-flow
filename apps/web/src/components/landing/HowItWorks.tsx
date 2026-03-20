const STEPS = [
  {
    step: '1',
    title: 'Point your SDK',
    description: (
      <>
        Set your base URL to{' '}
        <code className="font-mono text-primary">
          gateway.trace-flow.dev/{'{'}
          <em>provider</em>
          {'}'}/
        </code>
      </>
    ),
  },
  {
    step: '2',
    title: 'Add one header',
    description: (
      <>
        Include <code className="font-mono text-primary">X-Trace-Flow-Api-Key</code> with your API
        key.
      </>
    ),
  },
  {
    step: '3',
    title: 'See everything',
    description: 'Cost, tokens, latency, and full request/response bodies in the dashboard.',
  },
];

export function HowItWorks() {
  return (
    <section className="relative bg-card/30 py-24">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-border to-transparent" />
      <div className="mx-auto max-w-3xl px-6">
        <div className="mb-16 text-center">
          <h2 className="mb-3 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            Up and running in minutes.
          </h2>
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
              <h3 className="mb-2 font-mono text-sm font-semibold text-foreground">{title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
            </div>
          ))}
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-linear-to-r from-transparent via-border to-transparent" />
    </section>
  );
}
