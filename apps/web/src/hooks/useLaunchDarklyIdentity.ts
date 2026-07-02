'use client';

import { useEffect, useRef } from 'react';
import { useLDClient } from 'launchdarkly-react-client-sdk';
import type { Doc } from '@trace-flow/convex/_generated/dataModel';

export function useLaunchDarklyIdentity(
  user: Doc<'users'> | null,
  subscription: Doc<'subscriptions'> | null,
) {
  const ldClient = useLDClient();
  const identifiedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!ldClient || !user) return;
    const identityKey = `${user.tokenIdentifier}:${subscription?.tier}`;
    if (identifiedKey.current === identityKey) return;

    void ldClient.identify({
      kind: 'user',
      key: user.tokenIdentifier,
      email: user.email,
      name: user.name,
      tier: subscription?.tier,
    });
    identifiedKey.current = identityKey;
  }, [ldClient, user, subscription]);
}
