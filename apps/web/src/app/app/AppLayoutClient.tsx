'use client';

import { type Preloaded, useConvexAuth, usePreloadedQuery, useQuery } from 'convex/react';
import { type FunctionReturnType } from 'convex/server';
import { api } from '@trace-flow/convex/_generated/api';
import { Providers } from '@/components/providers/Providers';
import { AppSidebar } from '@/components/AppSidebar';
import { AdminProvider } from '@/components/admin/AdminContext';
import { AnalystProvider } from '@/components/analyst/AnalystContext';
import { AnalystSidebar } from '@/components/analyst/AnalystSidebar';
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
  const analystEnabled = data.subscription?.tier === 'pro' && data.subscription.status === 'active';

  return (
    <AdminProvider value={data.isAdmin}>
      <AnalystProvider enabled={analystEnabled}>
        <SidebarProvider>
          <AppSidebar isAdmin={data.isAdmin} />
          <div className="flex min-w-0 flex-1">
            <SidebarInset>
              <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-6 lg:p-8">
                {children}
              </div>
            </SidebarInset>
            {analystEnabled && <AnalystSidebar />}
          </div>
        </SidebarProvider>
      </AnalystProvider>
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
