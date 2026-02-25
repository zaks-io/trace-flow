'use client';

import { type Preloaded, useConvexAuth, usePreloadedQuery, useQuery } from 'convex/react';
import { type FunctionReturnType } from 'convex/server';
import { api } from '@convex/_generated/api';
import { Providers } from '@/components/Providers';
import { AppSidebar } from '@/components/AppSidebar';
import { AdminProvider } from '@/components/AdminContext';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { useUserInitialization } from '@/hooks/useUserInitialization';
import { useLaunchDarklyIdentity } from '@/hooks/useLaunchDarklyIdentity';
import { Loader2 } from 'lucide-react';

type SessionContext = typeof api.app.sessionContext;

function FullScreenSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  );
}

function RequireAuth({
  children,
  hasPreloadedData,
}: {
  children: React.ReactNode;
  hasPreloadedData: boolean;
}) {
  const { isLoading, isAuthenticated } = useConvexAuth();

  if (isLoading) {
    // If we have preloaded data, render immediately — auth will resolve in the background
    if (hasPreloadedData) return <>{children}</>;
    return <FullScreenSpinner />;
  }

  // Auth hook handles the redirect — show loading while it happens
  if (!isAuthenticated) return <FullScreenSpinner />;

  return <>{children}</>;
}

function AppLayoutInnerWithPreload({
  preloadedSessionContext,
  children,
}: {
  preloadedSessionContext: Preloaded<SessionContext>;
  children: React.ReactNode;
}) {
  const data = usePreloadedQuery(preloadedSessionContext);
  return <AppLayoutContent data={data}>{children}</AppLayoutContent>;
}

function AppLayoutInnerWithQuery({ children }: { children: React.ReactNode }) {
  const data = useQuery(api.app.sessionContext);

  if (data === undefined) {
    return <FullScreenSpinner />;
  }

  return <AppLayoutContent data={data}>{children}</AppLayoutContent>;
}

function AppLayoutContent({
  data,
  children,
}: {
  data: FunctionReturnType<SessionContext>;
  children: React.ReactNode;
}) {
  useUserInitialization();
  useLaunchDarklyIdentity(data.user, data.subscription);

  if (!data.hasRole) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-8 text-center">
          <h2 className="mb-2 text-xl font-semibold text-destructive">Access Denied</h2>
          <p className="text-destructive/80">
            You need the &quot;TraceFlow&quot; role to access this dashboard.
          </p>
        </div>
      </div>
    );
  }

  return (
    <AdminProvider value={data.isAdmin}>
      <SidebarProvider>
        <AppSidebar isAdmin={data.isAdmin} />
        <SidebarInset>
          <main className="flex flex-1 flex-col overflow-hidden p-4 pt-3">{children}</main>
        </SidebarInset>
      </SidebarProvider>
    </AdminProvider>
  );
}

interface AppLayoutClientProps {
  preloadedSessionContext: Preloaded<SessionContext> | null;
  children: React.ReactNode;
}

export function AppLayoutClient({ preloadedSessionContext, children }: AppLayoutClientProps) {
  return (
    <Providers>
      <RequireAuth hasPreloadedData={preloadedSessionContext !== null}>
        {preloadedSessionContext ? (
          <AppLayoutInnerWithPreload preloadedSessionContext={preloadedSessionContext}>
            {children}
          </AppLayoutInnerWithPreload>
        ) : (
          <AppLayoutInnerWithQuery>{children}</AppLayoutInnerWithQuery>
        )}
      </RequireAuth>
    </Providers>
  );
}
