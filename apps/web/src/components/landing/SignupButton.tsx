'use client';

import dynamic from 'next/dynamic';

const WaitlistForm = dynamic(() => import('./WaitlistForm').then((module) => module.WaitlistForm));

interface SignupButtonProps {
  isWaitlistMode: boolean;
}

export function SignupButton({ isWaitlistMode }: SignupButtonProps) {
  if (isWaitlistMode) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-muted-foreground">
          A small group of teams is testing Trace Flow now.
        </p>
        <WaitlistForm />
      </div>
    );
  }

  return (
    <a
      href="/auth/login?screen_hint=signup"
      className="inline-flex h-11 items-center justify-center whitespace-nowrap rounded-md bg-primary px-7 text-sm font-medium text-primary-foreground ring-offset-background transition-[background-color,transform] hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:translate-y-px"
    >
      Start free
    </a>
  );
}
