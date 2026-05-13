'use client';

import { useFlags } from 'launchdarkly-react-client-sdk';

export function useProSubscriptionEnabled(): boolean {
  const flags = useFlags<{ proSubscriptionEnabled?: boolean }>();
  return flags.proSubscriptionEnabled ?? false;
}
