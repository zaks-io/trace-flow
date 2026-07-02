'use client';

import { useEffect } from 'react';
import { type Preloaded, useMutation, usePreloadedQuery, useQuery } from 'convex/react';
import { api } from '@trace-flow/convex/_generated/api';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import { useDefaultApiKey } from '@/hooks/useDefaultApiKey';
import { GettingStarted } from '@/components/onboarding/GettingStarted';
import { UsageAnalytics } from './UsageAnalytics';

type TinybirdTraceListResponse = {
  data: Array<{ TraceId: string }>;
};

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
}: {
  preloadedApiKeys: Preloaded<typeof api.apiKeys.list>;
}) {
  const sessionContext = useQuery(api.app.sessionContext);
  const apiKeys = usePreloadedQuery(preloadedApiKeys);
  const { primaryApiKey, isCreatingDefaultKey, defaultKeyError } = useDefaultApiKey(
    apiKeys,
    Boolean(sessionContext?.user),
  );

  const onboardingCompleted = Boolean(sessionContext?.onboardingCompletedAt);
  const completeOnboarding = useMutation(api.auth.organizations.completeOnboarding);

  const firstTraceQuery = useTinybirdQuery<TinybirdTraceListResponse>({
    pipe: 'traces_list',
    params: { limit: 1 },
    enabled: Boolean(sessionContext?.user) && !onboardingCompleted,
    pollInterval: 10_000,
    staleTime: 0,
  });

  const tinybirdHasTraces = (firstTraceQuery.data?.data?.length ?? 0) > 0;

  useEffect(() => {
    if (tinybirdHasTraces && !onboardingCompleted) {
      completeOnboarding().catch((e) => console.error('Failed to complete onboarding:', e));
    }
  }, [tinybirdHasTraces, onboardingCompleted, completeOnboarding]);

  if (sessionContext === undefined) {
    return <UsageLoadingState />;
  }

  if (onboardingCompleted || tinybirdHasTraces) {
    return <UsageAnalytics preloadedApiKeys={preloadedApiKeys} />;
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
