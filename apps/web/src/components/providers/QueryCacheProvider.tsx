'use client';

import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { type ReactNode, useLayoutEffect, useMemo, useState } from 'react';
import { createQueryCacheScope } from './query-cache';

export function QueryCacheProvider({
  identity,
  fallback,
  children,
}: {
  identity: string;
  fallback: ReactNode;
  children: ReactNode;
}) {
  const [ready, setReady] = useState(false);
  const scope = useMemo(
    () =>
      typeof window === 'undefined' ? null : createQueryCacheScope(window.sessionStorage, identity),
    [identity],
  );

  useLayoutEffect(() => {
    if (!scope) return;
    scope.activate();
    setReady(true);
    return () => scope.dispose();
  }, [scope]);

  if (!scope || !ready) return fallback;

  return (
    <PersistQueryClientProvider
      key={identity}
      client={scope.queryClient}
      persistOptions={{
        persister: scope.persister,
        buster: process.env.NEXT_PUBLIC_DEPLOY_ID ?? 'dev',
      }}
    >
      {children}
    </PersistQueryClientProvider>
  );
}
