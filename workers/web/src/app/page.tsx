'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Activity, ArrowRight, BookOpen } from 'lucide-react';

function FlowingTraces() {
  return (
    <svg
      className="absolute inset-0 h-full w-full"
      viewBox="0 0 1200 800"
      preserveAspectRatio="xMidYMid slice"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="traceGradient1" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="oklch(0.65 0.2 262)" stopOpacity="0" />
          <stop offset="50%" stopColor="oklch(0.65 0.2 262)" stopOpacity="0.4" />
          <stop offset="100%" stopColor="oklch(0.65 0.2 262)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="traceGradient2" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="oklch(0.7 0.18 165)" stopOpacity="0" />
          <stop offset="50%" stopColor="oklch(0.7 0.18 165)" stopOpacity="0.3" />
          <stop offset="100%" stopColor="oklch(0.7 0.18 165)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="traceGradient3" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="oklch(0.65 0.2 310)" stopOpacity="0" />
          <stop offset="50%" stopColor="oklch(0.65 0.2 310)" stopOpacity="0.25" />
          <stop offset="100%" stopColor="oklch(0.65 0.2 310)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Flowing trace paths */}
      <path
        d="M-100 200 Q 200 150, 400 250 T 800 200 T 1300 280"
        fill="none"
        stroke="url(#traceGradient1)"
        strokeWidth="2"
        className="animate-trace-1"
      />
      <path
        d="M-100 400 Q 300 350, 500 450 T 900 380 T 1300 420"
        fill="none"
        stroke="url(#traceGradient2)"
        strokeWidth="1.5"
        className="animate-trace-2"
      />
      <path
        d="M-100 550 Q 250 500, 450 580 T 850 520 T 1300 600"
        fill="none"
        stroke="url(#traceGradient3)"
        strokeWidth="2"
        className="animate-trace-3"
      />
      <path
        d="M-100 700 Q 350 650, 550 720 T 950 680 T 1300 750"
        fill="none"
        stroke="url(#traceGradient1)"
        strokeWidth="1"
        className="animate-trace-4"
      />

      {/* Subtle nodes */}
      <circle
        cx="400"
        cy="250"
        r="3"
        fill="oklch(0.65 0.2 262)"
        opacity="0.3"
        className="animate-pulse-slow"
      />
      <circle
        cx="800"
        cy="200"
        r="2"
        fill="oklch(0.7 0.18 165)"
        opacity="0.25"
        className="animate-pulse-slow delay-1s"
      />
      <circle
        cx="500"
        cy="450"
        r="2.5"
        fill="oklch(0.7 0.18 165)"
        opacity="0.3"
        className="animate-pulse-slow delay-2s"
      />
      <circle
        cx="850"
        cy="520"
        r="3"
        fill="oklch(0.65 0.2 310)"
        opacity="0.25"
        className="animate-pulse-slow delay-3s"
      />
    </svg>
  );
}

export default function Home() {
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
          <Activity className="h-4 w-4 text-primary" />
          <span className="font-mono text-sm text-primary">LLM Observability</span>
        </div>

        {/* Headline */}
        <h1 className="delay-150 animate-hero-fade mb-6 text-4xl font-bold tracking-tight text-foreground sm:text-5xl md:text-6xl">
          See Every Request.
          <br />
          <span className="text-primary">Understand Every Response.</span>
        </h1>

        {/* Subheadline */}
        <p className="delay-300 animate-hero-fade mb-10 text-lg text-muted-foreground sm:text-xl">
          Trace, analyze, and optimize your LLM integrations with real-time observability.
        </p>

        {/* CTAs */}
        <div className="delay-450 animate-hero-fade flex flex-col items-center justify-center gap-4 sm:flex-row">
          <Button asChild size="lg" className="glow-primary">
            <Link href="/app">
              Sign In
              <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </Button>
          <Button asChild variant="outline" size="lg">
            <Link href="/docs">
              <BookOpen className="mr-1 h-4 w-4" />
              View Docs
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
