import { useQuery } from 'convex/react';
import { Authenticated, Unauthenticated, AuthLoading } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { AppSidebar } from '@/components/AppSidebar';
import { SidebarProvider, SidebarInset, SidebarTrigger } from '@/components/ui/sidebar';

interface AppLayoutProps {
  children: React.ReactNode;
}

function AppContent({ children }: AppLayoutProps) {
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

export function AppLayout({ children }: AppLayoutProps) {
  return <AppContent>{children}</AppContent>;
}
