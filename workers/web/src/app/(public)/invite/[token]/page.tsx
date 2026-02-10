'use client';

import { use, useEffect, useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';

export default function InviteAcceptPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const invite = useQuery(api.invites.getInviteByToken, { token });
  const acceptInvite = useMutation(api.invites.acceptInvite);
  const [status, setStatus] = useState<'loading' | 'accepting' | 'success' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    if (invite === undefined) return; // Still loading

    if (invite?.status !== 'pending') {
      setStatus('error');
      setErrorMessage(
        !invite
          ? 'This invite link is invalid.'
          : invite.status === 'accepted'
            ? 'This invite has already been used.'
            : 'This invite has expired.',
      );
      return;
    }

    if (status !== 'loading') return;

    setStatus('accepting');
    acceptInvite({ token })
      .then((result) => {
        setStatus('success');
        const loginUrl = `/auth/login?login_hint=${encodeURIComponent(result.email)}&screen_hint=signup&returnTo=/app`;
        window.location.href = loginUrl;
      })
      .catch((err) => {
        setStatus('error');
        setErrorMessage(err instanceof Error ? err.message : 'Failed to accept invite');
      });
  }, [invite, token, acceptInvite, status]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="mx-auto max-w-md px-6 text-center">
        {(status === 'loading' || status === 'accepting') && (
          <div>
            <div className="mb-4 text-lg font-semibold text-foreground">
              Accepting your invite...
            </div>
            <p className="text-sm text-muted-foreground">
              You&apos;ll be redirected to create your account.
            </p>
          </div>
        )}

        {status === 'success' && (
          <div>
            <div className="mb-4 text-lg font-semibold text-foreground">Invite accepted!</div>
            <p className="text-sm text-muted-foreground">Redirecting you to sign up...</p>
          </div>
        )}

        {status === 'error' && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-8">
            <h2 className="mb-2 text-xl font-semibold text-destructive">Invalid Invite</h2>
            <p className="text-destructive/80">{errorMessage}</p>
          </div>
        )}
      </div>
    </div>
  );
}
