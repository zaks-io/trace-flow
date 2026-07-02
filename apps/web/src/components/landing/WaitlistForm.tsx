'use client';

import { useState } from 'react';
import { useMutation } from 'convex/react';
import { api } from '@trace-flow/convex/_generated/api';

export function WaitlistForm() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'already' | 'error'>(
    'idle',
  );
  const [confirmed, setConfirmed] = useState(false);
  const joinWaitlist = useMutation(api.waitlist.joinWaitlist);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;

    setStatus('submitting');

    try {
      const result = await joinWaitlist({ email, source: 'landing_page' });
      if (result.status === 'already_on_waitlist') {
        setConfirmed(result.confirmed);
        setStatus('already');
      } else {
        setStatus('success');
      }
    } catch {
      setStatus('error');
    }
  }

  if (status === 'success') {
    return (
      <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-6 py-3">
        <svg
          className="h-5 w-5 text-primary"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M22 13V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h8" />
          <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
          <path d="m16 19 2 2 4-4" />
        </svg>
        <span className="text-sm font-medium text-primary">
          Check your email to confirm your spot
        </span>
      </div>
    );
  }

  if (status === 'already') {
    return (
      <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-6 py-3">
        <svg
          className="h-5 w-5 text-primary"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <path d="m9 11 3 3L22 4" />
        </svg>
        <span className="text-sm font-medium text-primary">
          {confirmed
            ? "You're already on the list \u2014 we'll be in touch!"
            : "You're already on the list! Check your email for the confirmation link."}
        </span>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col items-center gap-3">
      <div className="flex w-full max-w-sm gap-2">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@email.com"
          className="h-11 flex-1 rounded-md border border-input bg-background px-4 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          disabled={status === 'submitting'}
        />
        <button
          type="submit"
          disabled={status === 'submitting'}
          className="glow-primary inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground ring-offset-background transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
        >
          {status === 'submitting' ? 'Joining...' : 'Join Waitlist'}
        </button>
      </div>
      {status === 'error' && (
        <div className="rounded-md border border-destructive/20 bg-destructive/5 px-4 py-2">
          <p className="text-sm text-destructive">Something went wrong. Please try again.</p>
        </div>
      )}
    </form>
  );
}
