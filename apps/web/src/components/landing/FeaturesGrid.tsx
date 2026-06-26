const FEATURES = [
  {
    title: 'Async capture',
    description:
      'Cloudflare waitUntil() keeps observability writes off the user-visible response path.',
    icon: <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />,
  },
  {
    title: 'Cost estimates per request',
    description:
      'Token counts and model pricing produce comparable spend signals across providers.',
    icon: (
      <>
        <line x1="12" x2="12" y1="2" y2="22" />
        <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
      </>
    ),
  },
  {
    title: 'Body capture controls',
    description:
      'Captured request and response samples are encrypted on edge, with opt-out support for sensitive calls.',
    icon: (
      <>
        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" x2="8" y1="13" y2="13" />
        <line x1="16" x2="8" y1="17" y2="17" />
        <line x1="10" x2="8" y1="9" y2="9" />
      </>
    ),
  },
  {
    title: 'Streaming support',
    description:
      'SSE from all providers. Thinking tokens, tool calls, text \u2014 all decomposed per content block.',
    icon: (
      <>
        <path d="M2 20h.01" />
        <path d="M7 20v-4" />
        <path d="M12 20v-8" />
        <path d="M17 20V8" />
        <path d="M22 4v16" />
      </>
    ),
  },
  {
    title: 'Unified dashboard',
    description: 'Cost trends, token breakdowns, projected spend. One view across all providers.',
    icon: (
      <>
        <rect width="18" height="18" x="3" y="3" rx="2" />
        <path d="M3 9h18" />
        <path d="M9 21V9" />
      </>
    ),
  },
  {
    title: 'Soft enforcement',
    description:
      'Never blocks your LLM calls. When you hit limits, we stop recording \u2014 your users never notice.',
    icon: (
      <>
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
        <path d="m9 12 2 2 4-4" />
      </>
    ),
  },
] as const;

export function FeaturesGrid() {
  return (
    <section className="bg-background py-24">
      <div className="mx-auto max-w-5xl px-6">
        <div className="mb-12 text-center">
          <h2 className="mb-3 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            Built for real traffic.
          </h2>
          <p className="text-lg text-muted-foreground">
            Everything you need to understand your LLM spend.
          </p>
        </div>

        <div className="stagger-children grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <div
              key={feature.title}
              className="group rounded-lg border border-border bg-card/50 p-6 transition-all duration-200 hover:border-primary/20 hover:bg-card"
            >
              <div className="mb-4 inline-flex rounded-md border border-primary/15 bg-primary/5 p-2 transition-colors group-hover:border-primary/25 group-hover:bg-primary/10">
                <svg
                  className="h-5 w-5 text-primary"
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  {feature.icon}
                </svg>
              </div>
              <h3 className="mb-2 font-mono text-sm font-semibold text-foreground">
                {feature.title}
              </h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{feature.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
