import Link from 'next/link';
import { CalendarClock, FileLock2, KeyRound, ScanEye } from 'lucide-react';

const COMMITMENTS = [
  {
    icon: ScanEye,
    title: 'Transcripts are parsed on your machine',
    body: 'The desktop app uploads typed facts such as model, tokens, tool outcomes, and redacted excerpts. It does not upload raw transcripts.',
  },
  {
    icon: KeyRound,
    title: 'Provider keys pass straight through',
    body: 'Your provider API keys authenticate upstream. They are never written to our database, analytics, or stored bodies.',
  },
  {
    icon: FileLock2,
    title: 'Bodies are encrypted, or skipped',
    body: (
      <>
        Stored requests and responses use per-organization AES-256-GCM keys. Send{' '}
        <code className="whitespace-nowrap font-mono text-[13px] text-foreground">
          X-Trace-Flow-Omit-Body
        </code>{' '}
        to keep usage metadata only.
      </>
    ),
  },
  {
    icon: CalendarClock,
    title: 'Retention you can plan around',
    body: 'Request traces stay 7 days on Hobby and 30 on Pro. Coding-agent analytics stay a year, monthly totals five.',
  },
];

export function PrivacySection() {
  return (
    <section className="relative border-y border-border/70 bg-card/20 py-24 sm:py-32">
      <div className="mx-auto grid max-w-7xl gap-12 px-5 sm:px-8 lg:grid-cols-[1fr_1.5fr] lg:gap-20">
        <div>
          <h2 className="text-balance text-3xl font-semibold tracking-[-0.035em] text-foreground sm:text-5xl">
            What we keep, and what we don&apos;t.
          </h2>
          <p className="mt-5 max-w-md text-lg leading-8 text-muted-foreground">
            What each path sends to Trace Flow, and how long it stays.
          </p>
          <div className="mt-8 flex gap-6 text-sm font-medium">
            <Link
              href="/privacy"
              className="text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-primary"
            >
              Privacy policy
            </Link>
            <Link
              href="/security"
              className="text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-primary"
            >
              Security
            </Link>
          </div>
        </div>

        <dl className="grid gap-x-10 gap-y-10 sm:grid-cols-2">
          {COMMITMENTS.map(({ icon: Icon, title, body }) => (
            <div key={title}>
              <dt className="flex items-center gap-3 text-base font-semibold text-foreground">
                <Icon
                  className="size-5 shrink-0 text-primary"
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
                {title}
              </dt>
              <dd className="mt-2 text-sm leading-6 text-muted-foreground">{body}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
