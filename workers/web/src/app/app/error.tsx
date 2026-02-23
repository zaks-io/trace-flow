'use client';

import { useEffect } from 'react';
import { ConvexTokenError } from '@/lib/convex';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('App error boundary caught:', error);
  }, [error]);

  if (error instanceof ConvexTokenError || error.name === 'ConvexTokenError') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <h2 className="mb-2 text-xl font-semibold text-foreground">Session Expired</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Your session has expired. Please sign in again.
          </p>
          <a
            href="/auth/login?returnTo=/app"
            className="inline-flex items-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Sign In
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-8 text-center">
        <h2 className="mb-2 text-xl font-semibold text-destructive">Something went wrong</h2>
        <p className="mb-4 text-sm text-destructive/80">
          An error occurred while loading the application.
        </p>
        <button
          onClick={reset}
          className="inline-flex items-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Try Again
        </button>
      </div>
    </div>
  );
}
