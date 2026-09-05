import Link from 'next/link';
import { FlowingTraces } from './FlowingTraces';
import { AgentAnalyticsPreview } from './AgentAnalyticsPreview';
import { SignupButton } from './SignupButton';

interface HeroSectionProps {
  isWaitlistMode: boolean;
}

export function HeroSection({ isWaitlistMode }: HeroSectionProps) {
  return (
    <section className="relative overflow-hidden bg-background pb-20 pt-6 sm:pb-28">
      <div className="bg-grid-pattern pointer-events-none absolute inset-0 opacity-[0.03]" />
      <div className="pointer-events-none absolute inset-0 opacity-35">
        <FlowingTraces />
      </div>
      <div className="bg-radial-fade pointer-events-none absolute inset-0" />
      <div className="pointer-events-none absolute left-1/2 top-40 h-[480px] w-[760px] -translate-x-1/2 rounded-full bg-primary/5 blur-[120px]" />

      <div className="relative z-10 mx-auto max-w-7xl px-5 sm:px-8">
        <nav
          className="mb-20 flex items-center justify-between sm:mb-24"
          aria-label="Main navigation"
        >
          <Link href="/" className="flex items-center gap-3 font-mono text-sm font-semibold">
            <span className="flex h-7 w-7 items-center justify-center rounded-md border border-primary/35 bg-primary/10 text-primary">
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
                <path
                  d="M3 12h4l2.2-7 5.2 14 2.2-7H21"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            Trace Flow
          </Link>
          <div className="flex items-center gap-1 sm:gap-3">
            <Link
              href="/docs"
              className="rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Docs
            </Link>
            <Link
              href="/auth/login"
              className="rounded-md border border-border bg-card/70 px-3 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary/30 hover:bg-card sm:px-4"
            >
              Sign in
            </Link>
          </div>
        </nav>

        <div className="mx-auto mb-14 max-w-4xl text-center sm:mb-16">
          <h1 className="delay-150 animate-hero-fade text-balance text-4xl font-semibold tracking-[-0.045em] text-foreground sm:text-6xl lg:text-7xl">
            See what your AI work costs.
            <span className="block text-primary">Find what needs a closer look.</span>
          </h1>

          <p className="delay-300 animate-hero-fade mx-auto mt-7 max-w-2xl text-balance text-lg leading-8 text-muted-foreground sm:text-xl">
            Track estimated spending, growing context, and tool failures across coding sessions.
            Capture analytics with the desktop app, or connect your SDK to track model-call costs
            and performance. Compare the data over time in your dashboard.
          </p>

          <div className="delay-450 animate-hero-fade mt-9 flex flex-col items-center gap-4">
            <SignupButton isWaitlistMode={isWaitlistMode} />
            <Link
              href="#product"
              className="text-sm font-medium text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-primary"
            >
              See what you can track
            </Link>
          </div>
        </div>
        <div className="relative mx-auto max-w-6xl animate-dashboard-reveal">
          <div className="absolute -inset-4 rounded-[2rem] bg-primary/5 blur-3xl" />
          <AgentAnalyticsPreview />
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-linear-to-t from-background to-transparent" />
    </section>
  );
}
