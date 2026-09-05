'use client';

import Link from 'next/link';
import { EmailContactLink } from '@/components/shared/EmailContactLink';
import { WaitlistForm } from './WaitlistForm';

interface SignupButtonProps {
  isWaitlistMode: boolean;
}

export function SignupButton({ isWaitlistMode }: SignupButtonProps) {
  if (isWaitlistMode) {
    return (
      <div className="flex flex-col items-center gap-3">
        <p className="text-sm text-muted-foreground">Join the waitlist for an invitation.</p>
        <WaitlistForm />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <EmailContactLink
        localPart="info"
        domainParts={['trace-flow', 'dev']}
        label="Email Trace Flow to request access"
        obfuscatedText="Email to request access"
        className="glow-primary h-11 justify-center rounded-md bg-primary px-8 text-sm font-medium text-primary-foreground no-underline hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      />
      <Link
        href="/auth/login"
        className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
      >
        Already have access? Sign in
      </Link>
    </div>
  );
}
