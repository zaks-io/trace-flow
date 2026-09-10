'use client';

import { ConvexReactClient, ConvexProviderWithAuth } from 'convex/react';
import { type ReactNode, useMemo } from 'react';
import { useConvexAuthSession } from '@/hooks/useConvexAuthSession';

function ConvexAuthProvider({ children }: { children: ReactNode }) {
  const convex = useMemo(() => new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!), []);

  return (
    <ConvexProviderWithAuth client={convex} useAuth={useConvexAuthSession}>
      {children}
    </ConvexProviderWithAuth>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  return <ConvexAuthProvider>{children}</ConvexAuthProvider>;
}
