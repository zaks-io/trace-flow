import Link from 'next/link';
import { EmailContactLink } from '@/components/EmailContactLink';
import { SignupButton } from './SignupButton';

interface FooterCTAProps {
  isWaitlistMode: boolean;
}

export function FooterCTA({ isWaitlistMode }: FooterCTAProps) {
  return (
    <footer className="relative bg-card/30 py-24">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-border to-transparent" />

      <div className="mx-auto max-w-2xl px-6 text-center">
        <h2 className="mb-6 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
          Start tracking your LLM costs
          <br />
          <span className="text-primary">in 5 minutes.</span>
        </h2>

        <div className="mb-12">
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
