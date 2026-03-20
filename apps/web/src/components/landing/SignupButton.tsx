'use client';

import Link from 'next/link';
import { WaitlistForm } from './WaitlistForm';

interface SignupButtonProps {
  isWaitlistMode: boolean;
}

export function SignupButton({ isWaitlistMode }: SignupButtonProps) {
  if (isWaitlistMode) {
    return (
      <div className="flex flex-col items-center gap-3">
        <p className="text-sm text-muted-foreground">
          Currently invite-only. Join the waitlist for early access.
        </p>
        <WaitlistForm />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <p className="text-sm text-muted-foreground">
        Free tier — 25K traces/month. No credit card required.
      </p>
      <Link
        href="/auth/login"
        className="glow-primary inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-primary px-8 text-sm font-medium text-primary-foreground ring-offset-background transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        Get Started Free
      </Link>
    </div>
  );
}
