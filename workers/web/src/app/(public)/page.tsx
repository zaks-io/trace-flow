import Link from 'next/link';
import { FlowingTraces } from '@/components/landing/FlowingTraces';
import { WaitlistForm } from '@/components/landing/WaitlistForm';

export default function HomePage() {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-background">
      {/* Grid background */}
      <div className="bg-grid-pattern pointer-events-none absolute inset-0 opacity-[0.03]" />

      {/* Flowing traces */}
      <div className="pointer-events-none absolute inset-0 opacity-60">
        <FlowingTraces />
      </div>

      {/* Radial gradient overlay */}
      <div className="bg-radial-fade pointer-events-none absolute inset-0" />

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
          See Every Request.
          <br />
          <span className="text-primary">Understand Every Response.</span>
        </h1>

        {/* Subheadline */}
        <p className="delay-300 animate-hero-fade mb-4 text-lg text-muted-foreground sm:text-xl">
          Trace, analyze, and optimize your LLM integrations with real-time observability.
        </p>

        {/* Invite-only banner */}
        <p className="delay-300 animate-hero-fade mb-8 text-sm text-muted-foreground">
          Currently invite-only. Join the waitlist to get early access.
        </p>

        {/* Waitlist form + Docs link */}
        <div className="delay-450 animate-hero-fade flex flex-col items-center gap-6">
          <WaitlistForm />
          <Link
            href="/docs"
            className="inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-md border border-input bg-background px-8 text-sm font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
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
    </div>
  );
}
