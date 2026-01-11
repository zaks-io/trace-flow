export function FlowingTraces() {
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
