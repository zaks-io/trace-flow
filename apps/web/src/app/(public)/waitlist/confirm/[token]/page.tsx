'use client';

import { use, useEffect, useState } from 'react';
import { useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';

export default function WaitlistConfirmPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const confirmEmail = useMutation(api.waitlist.confirmEmail);
  const [status, setStatus] = useState<'confirming' | 'success' | 'error'>('confirming');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    confirmEmail({ token })
      .then((result) => {
        setStatus('success');
        if (result.alreadyConfirmed) {
          setErrorMessage('already');
        }
      })
      .catch((err) => {
        setStatus('error');
        setErrorMessage(err instanceof Error ? err.message : 'Failed to confirm email');
      });
  }, [token, confirmEmail]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="mx-auto max-w-md px-6 text-center">
        {status === 'confirming' && (
          <div>
            <div className="mb-4 text-lg font-semibold text-foreground">
              Confirming your email...
            </div>
          </div>
        )}

        {status === 'success' && (
          <div className="rounded-lg border border-primary/20 bg-primary/5 p-8">
            <div className="mb-2 text-xl font-semibold text-foreground">
              {errorMessage === 'already' ? 'Already Confirmed' : 'Email Confirmed!'}
            </div>
            <p className="text-muted-foreground">
              {errorMessage === 'already'
                ? "Your email was already confirmed. We'll notify you when access is available."
                : "You're on the waitlist. We'll send you an invite when access is available."}
            </p>
          </div>
        )}

        {status === 'error' && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-8">
            <h2 className="mb-2 text-xl font-semibold text-destructive">Confirmation Failed</h2>
            <p className="text-destructive/80">{errorMessage}</p>
          </div>
        )}
      </div>
    </div>
  );
}
