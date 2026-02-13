'use client';

import { type ReactNode } from 'react';
import { LDProvider } from 'launchdarkly-react-client-sdk';

export function LaunchDarklyProvider({ children }: { children: ReactNode }) {
  return (
    <LDProvider
      clientSideID={process.env.NEXT_PUBLIC_LAUNCHDARKLY_CLIENT_SIDE_ID!}
      reactOptions={{ useCamelCaseFlagKeys: true }}
    >
      {children}
    </LDProvider>
  );
}
