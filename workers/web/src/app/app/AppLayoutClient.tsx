'use client';

import { Providers } from '@/components/Providers';
import { AppSidebar } from '@/components/AppSidebar';
import { PageHeaderProvider } from '@/components/PageHeaderContext';
import { PageHeader } from '@/components/PageHeader';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { useUserInitialization } from '@/hooks/useUserInitialization';
import { useLaunchDarklyIdentity } from '@/hooks/useLaunchDarklyIdentity';

function AppLayoutInner({ children }: { children: React.ReactNode }) {
  useUserInitialization();
  useLaunchDarklyIdentity();
  const hasRole = useQuery(api.auth.hasTraceFlowRole);

  if (hasRole === undefined) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (hasRole === false) {
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
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <PageHeaderProvider>
          <PageHeader />
          <main className="flex-1 p-6">{children}</main>
        </PageHeaderProvider>
      </SidebarInset>
    </SidebarProvider>
  );
}

export function AppLayoutClient({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <AppLayoutInner>{children}</AppLayoutInner>
    </Providers>
  );
}
