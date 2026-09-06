'use client';

import { useQuery } from 'convex/react';
import { api } from '@trace-flow/convex/_generated/api';

export function useProSubscriptionEnabled(): boolean {
  return useQuery(api.integrations.splitch.proSubscriptionEnabled) ?? false;
}
