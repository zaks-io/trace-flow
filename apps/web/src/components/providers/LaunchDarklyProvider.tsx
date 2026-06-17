'use client';

import { type ReactNode } from 'react';
import { LDProvider } from 'launchdarkly-react-client-sdk';

const clientSideID = process.env.NEXT_PUBLIC_LAUNCHDARKLY_CLIENT_SIDE_ID;

export function LaunchDarklyProvider({ children }: { children: ReactNode }) {
  if (!clientSideID) {
    return <>{children}</>;
  }

  return (
    <LDProvider
      clientSideID={clientSideID}
      timeout={5}
      reactOptions={{ useCamelCaseFlagKeys: true }}
    >
      {children}
    </LDProvider>
  );
}
