import Link from 'next/link';

const STEPS = [
  {
    title: 'Install and sign in',
    description:
      'Connect the Trace Flow desktop app to your account. Available for macOS and Windows.',
  },
  {
    title: 'Start capturing',
    description:
      'Review the detected sources, then choose Start syncing. Capture analytics from Claude Code and Codex CLI, plus Cursor on macOS.',
  },
  {
    title: 'Leave it running',
    description:
      'The app syncs in the background as you work. Open your dashboard to investigate costs and performance, or pause syncing from the tray.',
  },
];

export function DesktopCapture() {
  return (
    <section className="relative bg-card/30 py-24">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-border to-transparent" />
      <div className="mx-auto max-w-5xl px-6">
        <div className="mb-12 text-center">
          <div className="mb-4 font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-primary">
            Desktop capture
          </div>
          <h2 className="mb-3 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            Keep your coding tools. Add the desktop app.
          </h2>
          <p className="mx-auto max-w-2xl text-lg leading-8 text-muted-foreground">
            Capture coding-session analytics without changing your workflow. The desktop app runs in
            your menu bar or system tray. Available to private-alpha testers.
          </p>
        </div>
        <div className="grid gap-5 sm:grid-cols-3">
          {STEPS.map(({ title, description }) => (
            <article key={title} className="rounded-xl border border-border bg-background p-6">
              <h3 className="text-sm font-semibold text-foreground">{title}</h3>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">{description}</p>
            </article>
          ))}
        </div>
        <div className="mt-8 text-center">
          <Link
            href="/docs/collector"
            className="text-sm font-medium text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-primary"
          >
            Download and set up the desktop app
          </Link>
        </div>
      </div>
    </section>
  );
}
