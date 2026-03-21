'use client';

import { ConvexReactClient, ConvexProviderWithAuth } from 'convex/react';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import { type ReactNode, useMemo } from 'react';
import { useConvexAuthSession } from '@/hooks/useConvexAuthSession';
import { LaunchDarklyProvider } from '@/components/providers/LaunchDarklyProvider';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30 * 1000,
      gcTime: 15 * 60 * 1000,
      refetchOnWindowFocus: false,
    },
  },
});

const persister = createSyncStoragePersister({
  storage: typeof window !== 'undefined' ? window.sessionStorage : undefined,
  throttleTime: 1000,
});

function ConvexAuthProvider({ children }: { children: ReactNode }) {
  const convex = useMemo(() => new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!), []);

  return (
    <ConvexProviderWithAuth client={convex} useAuth={useConvexAuthSession}>
      {children}
    </ConvexProviderWithAuth>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ConvexAuthProvider>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister,
          buster: process.env.NEXT_PUBLIC_DEPLOY_ID ?? 'dev',
        }}
      >
        <LaunchDarklyProvider>{children}</LaunchDarklyProvider>
      </PersistQueryClientProvider>
    </ConvexAuthProvider>
  );
}
