'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';

export default function InviteAcceptPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const invite = useQuery(api.auth.invites.getInviteByToken, { token });
  const [status, setStatus] = useState<'loading' | 'redirecting' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState('');

  const returnTo = `/app/invite/${encodeURIComponent(token)}`;
  const loginUrl = invite?.email
    ? `/auth/login?login_hint=${encodeURIComponent(invite.email)}&screen_hint=signup&returnTo=${encodeURIComponent(returnTo)}`
    : `/auth/login?screen_hint=signup&returnTo=${encodeURIComponent(returnTo)}`;

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

    setStatus('redirecting');
    window.location.href = loginUrl;
  }, [invite, loginUrl, status]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="mx-auto max-w-md px-6 text-center">
        {(status === 'loading' || status === 'redirecting') && (
          <div>
            <div className="mb-4 text-lg font-semibold text-foreground">Opening your invite...</div>
            <p className="text-sm text-muted-foreground">
              You&apos;ll be redirected to create your account before the invite is accepted.
            </p>
            {status === 'redirecting' ? (
              <Link
                className="mt-4 inline-block text-sm text-primary hover:underline"
                href={loginUrl}
              >
                Continue to sign up
              </Link>
            ) : null}
          </div>
        )}

        {status === 'error' && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-8">
            <h2 className="mb-2 text-xl font-semibold text-destructive">Invalid Invite</h2>
            <p className="text-destructive/80">{errorMessage}</p>
            {errorMessage.includes('seat limit') && (
              <p className="mt-3 text-sm text-destructive/80">
                Org owners can increase seats in{' '}
                <a className="underline" href="/app/settings/billing">
                  billing settings
                </a>
                .
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
