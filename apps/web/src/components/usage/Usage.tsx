'use client';

import { useEffect, useState } from 'react';
import { type Preloaded, useMutation, usePreloadedQuery, useQuery } from 'convex/react';
import { api } from '@trace-flow/convex/_generated/api';
import { RETENTION_DAYS } from '@trace-flow/types';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import { snapToMinute } from '@/lib/tinybird';
import { useDefaultApiKey } from '@/hooks/useDefaultApiKey';
import { GettingStarted } from '@/components/onboarding/GettingStarted';
import { UsageAnalytics } from './UsageAnalytics';
import type { SummaryRow } from './types';

// Onboarding flips on the first proxy request inside retention. Ask the summary pipe for
// the longest retention tier (the JWT narrows it to the org's own) and leave the end open
// so each poll sees new requests. The pipe picks the rollup tier for the window, so this
// reads a few hundred rollup rows where the old span-list probe scanned every span.
const LONGEST_RETENTION_MS = Math.max(...Object.values(RETENTION_DAYS)) * 86_400_000;

function UsageLoadingState() {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      Loading workspace...
    </div>
  );
}

export default function Usage({
  preloadedApiKeys,
  preloadedAnalyticsApiKeys,
}: {
  preloadedApiKeys: Preloaded<typeof api.apiKeys.list>;
  preloadedAnalyticsApiKeys: Preloaded<typeof api.apiKeys.listAnalytics>;
}) {
  const sessionContext = useQuery(api.app.sessionContext);
  const apiKeys = usePreloadedQuery(preloadedApiKeys);
  const { primaryApiKey, isCreatingDefaultKey, defaultKeyError } = useDefaultApiKey(
    apiKeys,
    Boolean(sessionContext?.user),
  );

  const onboardingCompleted = Boolean(sessionContext?.onboardingCompletedAt);
  const completeOnboarding = useMutation(api.auth.organizations.completeOnboarding);

  const [firstTraceParams] = useState(() => ({
    start_time_ns: snapToMinute(Date.now() - LONGEST_RETENTION_MS) * 1_000_000,
  }));
  const firstTraceQuery = useTinybirdQuery<SummaryRow>({
    pipe: 'llm_usage_summary',
    params: firstTraceParams,
    enabled: Boolean(sessionContext?.user) && !onboardingCompleted,
    pollInterval: 10_000,
    staleTime: 0,
  });

  const tinybirdHasTraces = (firstTraceQuery.data?.data?.[0]?.request_count ?? 0) > 0;

  useEffect(() => {
    if (tinybirdHasTraces && !onboardingCompleted) {
      completeOnboarding().catch((e) => console.error('Failed to complete onboarding:', e));
    }
  }, [tinybirdHasTraces, onboardingCompleted, completeOnboarding]);

  if (sessionContext === undefined) {
    return <UsageLoadingState />;
  }

  if (onboardingCompleted || tinybirdHasTraces) {
    return <UsageAnalytics preloadedApiKeys={preloadedAnalyticsApiKeys} />;
  }

  return (
    <GettingStarted
      apiKey={primaryApiKey?.key ?? null}
      isPreparingApiKey={isCreatingDefaultKey}
      apiKeyError={defaultKeyError}
      isWaitingForFirstTrace={
        !firstTraceQuery.error && (firstTraceQuery.isFetching || firstTraceQuery.isLoading)
      }
    />
  );
}
