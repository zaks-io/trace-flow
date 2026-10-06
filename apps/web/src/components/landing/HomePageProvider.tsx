'use client';

import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';

const ConvexClientProvider = dynamic(() =>
  import('@/components/providers/ConvexClientProvider').then(
    (module) => module.ConvexClientProvider,
  ),
);

export function HomePageProvider({
  children,
  isWaitlistMode,
}: {
  children: ReactNode;
  isWaitlistMode: boolean;
}) {
  return isWaitlistMode ? <ConvexClientProvider>{children}</ConvexClientProvider> : children;
}
