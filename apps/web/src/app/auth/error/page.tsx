import { AlertCircle, RotateCcw, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function AuthErrorPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="mx-4 w-full max-w-md rounded-lg border p-6">
        <div className="mb-4 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 shrink-0 text-destructive" />
          <h2 className="text-lg font-semibold">Authentication Error</h2>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          Unable to complete authentication. Please try again or sign out to start fresh.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button asChild className="w-full sm:flex-1">
            <a href="/auth/login">
              <RotateCcw className="mr-2 h-4 w-4" />
              Try again
            </a>
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
