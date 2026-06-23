'use client';

import { use, useEffect, useRef, useState } from 'react';
import { useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';

export default function AuthenticatedInviteAcceptPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const acceptInvite = useMutation(api.auth.invites.acceptInvite);
  const initializeUser = useMutation(api.auth.users.initializeUser);
  const [status, setStatus] = useState<'accepting' | 'success' | 'error'>('accepting');
  const [errorMessage, setErrorMessage] = useState('');
  const hasStarted = useRef(false);

  useEffect(() => {
    if (status !== 'accepting' || hasStarted.current) return;
    hasStarted.current = true;

    acceptInvite({ token })
      .then(async () => {
        await initializeUser();
        setStatus('success');
        window.location.href = '/app';
      })
      .catch((err) => {
        setStatus('error');
        setErrorMessage(err instanceof Error ? err.message : 'Failed to accept invite');
      });
  }, [acceptInvite, initializeUser, status, token]);

  return (
    <div className="flex min-h-[400px] items-center justify-center">
      <div className="mx-auto max-w-md px-6 text-center">
        {status === 'accepting' ? (
          <div>
            <div className="mb-4 text-lg font-semibold text-foreground">
              Accepting your invite...
            </div>
            <p className="text-sm text-muted-foreground">
              We&apos;re connecting this account to the invited organization.
            </p>
          </div>
        ) : null}

        {status === 'success' ? (
          <div>
            <div className="mb-4 text-lg font-semibold text-foreground">Invite accepted.</div>
            <p className="text-sm text-muted-foreground">Redirecting to your dashboard...</p>
          </div>
        ) : null}

        {status === 'error' ? (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-8">
            <h1 className="mb-2 text-xl font-semibold text-destructive">Could not accept invite</h1>
            <p className="text-destructive/80">{errorMessage}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
