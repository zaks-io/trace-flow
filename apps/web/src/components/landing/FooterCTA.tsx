import Link from 'next/link';
import { EmailContactLink } from '@/components/shared/EmailContactLink';
import { SignupButton } from './SignupButton';

interface FooterCTAProps {
  isWaitlistMode: boolean;
}

export function FooterCTA({ isWaitlistMode }: FooterCTAProps) {
  return (
    <footer className="relative bg-background py-24 sm:py-32">
      <div className="mx-auto max-w-2xl px-6 text-center">
        <h2 className="text-balance text-3xl font-semibold tracking-[-0.035em] text-foreground sm:text-5xl">
          See where your LLM spend goes.
        </h2>
        <p className="mx-auto mt-5 max-w-lg text-base leading-7 text-muted-foreground">
          Start on the free Hobby plan with 7 days of request history. Upgrade when you need more.
        </p>

        <div className="mt-8 mb-14 flex justify-center">
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

          <div className="flex gap-6 text-xs text-muted-foreground">
            <a
              href="https://github.com/zaks-io/trace-flow"
              className="transition-colors hover:text-foreground"
            >
              GitHub
            </a>
            <Link href="/terms" className="transition-colors hover:text-foreground">
              Terms
            </Link>
            <Link href="/privacy" className="transition-colors hover:text-foreground">
              Privacy
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
