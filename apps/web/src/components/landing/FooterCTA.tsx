import Link from 'next/link';
import { EmailContactLink } from '@/components/shared/EmailContactLink';
import { SignupButton } from './SignupButton';

interface FooterCTAProps {
  isWaitlistMode: boolean;
}

export function FooterCTA({ isWaitlistMode }: FooterCTAProps) {
  return (
    <footer className="relative bg-card/30 py-24">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-border to-transparent" />

      <div className="mx-auto max-w-2xl px-6 text-center">
        <div className="mb-5 font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-primary">
          Private alpha
        </div>
        <h2 className="mb-5 text-3xl font-semibold tracking-[-0.035em] text-foreground sm:text-5xl">
          Your AI systems already leave a trail.
          <span className="block text-primary">Trace Flow makes it useful.</span>
        </h2>
        <p className="mx-auto mb-8 max-w-lg text-base leading-7 text-muted-foreground">
          We&apos;re working directly with early testers while the collector, agent analytics, and
          alerting workflows settle into their final shape.
        </p>

        <div className="mb-14">
          <SignupButton isWaitlistMode={isWaitlistMode} />
        </div>

        <div className="flex flex-col items-center gap-4">
          <p className="text-sm text-muted-foreground">
            Questions? Email{' '}
            <EmailContactLink
              localPart="info"
              domainParts={['trace-flow', 'dev']}
              label="Email the Trace Flow team"
              className="font-medium text-foreground decoration-foreground/60 hover:text-primary hover:decoration-primary"
            />
          </p>

          <div className="flex gap-4 text-xs text-muted-foreground/50">
            <Link href="/terms" className="transition-colors hover:text-foreground">
              Terms
            </Link>
            <span>&middot;</span>
            <Link href="/privacy" className="transition-colors hover:text-foreground">
              Privacy
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
