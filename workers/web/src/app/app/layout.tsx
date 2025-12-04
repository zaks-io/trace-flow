'use client';

import { ConvexReactClient, useQuery } from 'convex/react';
import { ConvexProviderWithAuth0 } from 'convex/react-auth0';
import { Auth0Provider } from '@auth0/auth0-react';
import { Authenticated, Unauthenticated, AuthLoading } from 'convex/react';
import { useMemo } from 'react';
import { api } from '../../../../../convex/_generated/api';
import { AppSidebar } from '@/components/AppSidebar';
import { SidebarProvider, SidebarInset, SidebarTrigger } from '@/components/ui/sidebar';

function AppContent({ children }: { children: React.ReactNode }) {
  const hasRole = useQuery(api.auth.hasTraceFlowRole);

  return (
    <>
      <AuthLoading>
        <div className="flex min-h-screen items-center justify-center bg-background">
          <div className="text-muted-foreground">Loading...</div>
        </div>
      </AuthLoading>
      <Unauthenticated>
        <SidebarProvider>
          <AppSidebar />
          <SidebarInset>
            <header className="flex h-14 items-center gap-4 border-b border-border px-6">
              <SidebarTrigger className="-ml-2" />
              <h1 className="text-sm font-medium text-foreground">Trace Flow</h1>
            </header>
            <main className="flex-1 p-6">
              <div className="rounded-lg border border-border bg-card p-8 text-center">
                <h2 className="mb-2 text-xl font-semibold text-foreground">
                  Authentication Required
                </h2>
                <p className="text-muted-foreground">Please log in to access the dashboard.</p>
              </div>
            </main>
          </SidebarInset>
        </SidebarProvider>
      </Unauthenticated>
      <Authenticated>
        <SidebarProvider>
          <AppSidebar />
          <SidebarInset>
            <header className="flex h-14 items-center gap-4 border-b border-border px-6">
              <SidebarTrigger className="-ml-2" />
            </header>
            <main className="flex-1 p-6">
              {hasRole === undefined ? (
                <div className="flex items-center justify-center py-12">
                  <div className="text-muted-foreground">Loading...</div>
                </div>
              ) : hasRole === false ? (
                <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-8 text-center">
                  <h2 className="mb-2 text-xl font-semibold text-destructive">Access Denied</h2>
                  <p className="text-destructive/80">
                    You need the &quot;TraceFlow&quot; role to access this dashboard.
                  </p>
                </div>
              ) : (
                children
              )}
            </main>
          </SidebarInset>
        </SidebarProvider>
      </Authenticated>
    </>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const convex = useMemo(() => {
    const url = process.env.NEXT_PUBLIC_CONVEX_URL ?? '';
    return new ConvexReactClient(url);
  }, []);

  return (
    <Auth0Provider
      domain={process.env.NEXT_PUBLIC_AUTH0_DOMAIN ?? ''}
      clientId={process.env.NEXT_PUBLIC_AUTH0_CLIENT_ID ?? ''}
      authorizationParams={{
        redirect_uri: typeof window !== 'undefined' ? window.location.origin : '',
        scope: 'openid profile email offline_access',
      }}
      useRefreshTokens={true}
      cacheLocation="localstorage"
    >
      <ConvexProviderWithAuth0 client={convex}>
        <AppContent>{children}</AppContent>
      </ConvexProviderWithAuth0>
    </Auth0Provider>
  );
}
