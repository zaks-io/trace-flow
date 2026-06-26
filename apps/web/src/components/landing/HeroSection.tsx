import Link from 'next/link';
import { FlowingTraces } from './FlowingTraces';
import { SignupButton } from './SignupButton';

interface HeroSectionProps {
  isWaitlistMode: boolean;
}

export function HeroSection({ isWaitlistMode }: HeroSectionProps) {
  return (
    <section className="relative flex min-h-[90vh] flex-col items-center justify-center overflow-hidden bg-background">
      {/* Grid background */}
      <div className="bg-grid-pattern pointer-events-none absolute inset-0 opacity-[0.03]" />

      {/* Flowing traces */}
      <div className="pointer-events-none absolute inset-0 opacity-60">
        <FlowingTraces />
      </div>

      {/* Radial gradient overlay */}
      <div className="bg-radial-fade pointer-events-none absolute inset-0" />

      {/* Warm ambient glow behind content */}
      <div className="pointer-events-none absolute top-1/3 left-1/2 h-[500px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/3 blur-[100px]" />

      {/* Hero content */}
      <div className="relative z-10 mx-auto max-w-2xl px-6 text-center">
        {/* Badge */}
        <div className="mb-8 inline-flex animate-hero-fade items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-4 py-1.5">
          <svg
            className="h-4 w-4 text-primary"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />
          </svg>
          <span className="font-mono text-sm text-primary">LLM Observability</span>
        </div>

        {/* Headline */}
        <h1 className="delay-150 animate-hero-fade mb-6 text-4xl font-bold tracking-tight text-foreground sm:text-5xl md:text-6xl">
          Know what your
          <br />
          <span className="text-primary">LLM calls cost.</span>
        </h1>

        {/* Subheadline */}
        <p className="delay-300 animate-hero-fade mx-auto mb-10 max-w-lg text-lg leading-relaxed text-muted-foreground sm:text-xl">
          Drop-in proxy for OpenAI, Anthropic, Google, and more. Capture token usage, cost
          estimates, and encrypted body samples without blocking the response path.
        </p>

        {/* CTA */}
        <div className="delay-450 animate-hero-fade flex flex-col items-center gap-5">
          <SignupButton isWaitlistMode={isWaitlistMode} />
          <Link
            href="/docs"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md px-6 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <svg
              className="h-4 w-4"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 7v14" />
              <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
            </svg>
            View Docs
          </Link>
        </div>
      </div>

      {/* Bottom fade into next section */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-linear-to-t from-background to-transparent" />
    </section>
  );
}
