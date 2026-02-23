'use client';

import { type Preloaded, usePreloadedQuery } from 'convex/react';
import { type api } from '@convex/_generated/api';
import { Providers } from '@/components/Providers';
import { AppSidebar } from '@/components/AppSidebar';
import { PageHeaderProvider } from '@/components/PageHeaderContext';
import { PageHeader } from '@/components/PageHeader';
import { AdminProvider } from '@/components/AdminContext';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { useUserInitialization } from '@/hooks/useUserInitialization';
import { useLaunchDarklyIdentity } from '@/hooks/useLaunchDarklyIdentity';

interface AppLayoutInnerProps {
  preloadedSessionContext: Preloaded<typeof api.app.sessionContext>;
  children: React.ReactNode;
}

function AppLayoutInner({ preloadedSessionContext, children }: AppLayoutInnerProps) {
  const { hasRole, user, isAdmin, subscription } = usePreloadedQuery(preloadedSessionContext);
  useUserInitialization();
  useLaunchDarklyIdentity(user, subscription);

  if (!hasRole) {
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
    <AdminProvider value={isAdmin}>
      <SidebarProvider>
        <AppSidebar isAdmin={isAdmin} />
        <SidebarInset>
          <PageHeaderProvider>
            <PageHeader />
            <main className="flex-1 p-6">{children}</main>
          </PageHeaderProvider>
        </SidebarInset>
      </SidebarProvider>
    </AdminProvider>
  );
}

interface AppLayoutClientProps {
  preloadedSessionContext: Preloaded<typeof api.app.sessionContext>;
  children: React.ReactNode;
}

export function AppLayoutClient({ preloadedSessionContext, children }: AppLayoutClientProps) {
  return (
    <Providers>
      <AppLayoutInner preloadedSessionContext={preloadedSessionContext}>{children}</AppLayoutInner>
    </Providers>
  );
}
