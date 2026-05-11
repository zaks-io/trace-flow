import { cn } from '@/lib/utils';

const PLANS = [
  {
    name: 'Hobby',
    price: 'Free',
    period: '',
    features: ['25K traces/mo', '7 day retention', 'Community support'],
    highlighted: false,
  },
  {
    name: 'Pro',
    price: '$29',
    period: '/mo',
    features: [
      '100K traces/mo',
      '30 day retention',
      'Unlimited API keys',
      'Priority support',
      'Team members',
    ],
    highlighted: true,
  },
  {
    name: 'Addon',
    price: '$5',
    period: '/ 100K',
    features: ['Stackable traces', 'Extends Pro plan', 'Same retention', 'Volume discounts'],
    highlighted: false,
  },
];

export function PricingSection() {
  return (
    <section className="bg-background py-24">
      <div className="mx-auto max-w-4xl px-6">
        <div className="mb-12 text-center">
          <h2 className="mb-3 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            Simple pricing.
          </h2>
          <p className="text-lg text-muted-foreground">Start free. Scale when you need to.</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          {PLANS.map((plan) => (
            <div
              key={plan.name}
              className={cn(
                'relative rounded-lg border p-6 transition-colors',
                plan.highlighted
                  ? 'border-primary/30 bg-primary/3'
                  : 'border-border bg-card/50 hover:border-border/80',
              )}
            >
              {plan.highlighted && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="rounded-full bg-primary px-3 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-primary-foreground">
                    Popular
                  </span>
                </div>
              )}
              <h3 className="mb-4 font-mono text-sm font-semibold text-foreground">{plan.name}</h3>
              <div className="mb-6">
                <span className="text-3xl font-bold tracking-tight text-foreground">
                  {plan.price}
                </span>
                {plan.period && (
                  <span className="ml-0.5 text-sm text-muted-foreground">{plan.period}</span>
                )}
              </div>
              <ul className="space-y-2.5 text-sm text-muted-foreground">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-center gap-2">
                    <svg
                      className="h-3.5 w-3.5 shrink-0 text-primary/60"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="m5 12 5 5L20 7" />
                    </svg>
                    {feature}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
