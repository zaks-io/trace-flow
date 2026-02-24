'use client';

import { useEffect } from 'react';
import { AlertCircle, RotateCcw, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[app error boundary]', error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="mx-4 w-full max-w-md rounded-lg border p-6">
        <div className="mb-4 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 shrink-0 text-destructive" />
          <h2 className="text-lg font-semibold">Something went wrong</h2>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          An unexpected error occurred. You can try again or sign out to start fresh.
        </p>
        {process.env.NODE_ENV === 'development' && (
          <details className="mb-4 text-sm text-muted-foreground">
            <summary className="mb-2 cursor-pointer font-medium">Error details</summary>
            <div className="overflow-auto rounded-md bg-muted p-3">
              <p className="break-words font-mono text-xs">
                {error.message || 'No error message available'}
              </p>
              {error.digest && (
                <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
                  ID: {error.digest}
                </p>
              )}
            </div>
          </details>
        )}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button onClick={reset} className="w-full sm:flex-1">
            <RotateCcw className="mr-2 h-4 w-4" />
            Try again
          </Button>
          <Button asChild variant="outline" className="w-full sm:flex-1">
            <a href="/auth/logout">
              <LogOut className="mr-2 h-4 w-4" />
              Sign out
            </a>
          </Button>
        </div>
      </div>
    </div>
  );
}
