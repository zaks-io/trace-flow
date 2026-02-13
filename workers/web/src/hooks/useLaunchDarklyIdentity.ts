'use client';

import { useEffect, useRef } from 'react';
import { useLDClient } from 'launchdarkly-react-client-sdk';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';

export function useLaunchDarklyIdentity() {
  const ldClient = useLDClient();
  const user = useQuery(api.users.getCurrentUserQuery);
  const subscription = useQuery(api.subscriptions.getForCurrentUser);
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
