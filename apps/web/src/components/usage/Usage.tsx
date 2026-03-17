'use client';

import { useEffect, useRef, useState } from 'react';
import { type Preloaded, usePreloadedQuery, useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
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

  const foundTraces = useRef(false);
  const errorCount = useRef(0);

  const firstTraceQuery = useTinybirdQuery<TinybirdTraceListResponse>({
    pipe: 'traces_list',
    params: { limit: 1 },
    enabled: Boolean(sessionContext?.user) && !foundTraces.current && errorCount.current < 3,
    pollInterval: 10_000,
    staleTime: 0,
  });

  const [showSuccessBanner, setShowSuccessBanner] = useState(false);
  const previousHasTraces = useRef<boolean | null>(null);

  const hasTraces = (firstTraceQuery.data?.data?.length ?? 0) > 0;
  const shouldShowOnboarding = !hasTraces;

  useEffect(() => {
    if (hasTraces) foundTraces.current = true;
    if (previousHasTraces.current === false && hasTraces) {
      setShowSuccessBanner(true);
    }
    previousHasTraces.current = hasTraces;
  }, [hasTraces]);

  useEffect(() => {
    if (firstTraceQuery.error) errorCount.current += 1;
  }, [firstTraceQuery.error]);

  if (sessionContext === undefined) {
    return <UsageLoadingState />;
  }

  if (shouldShowOnboarding) {
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

  return (
    <UsageAnalytics preloadedApiKeys={preloadedApiKeys} showSuccessBanner={showSuccessBanner} />
  );
}
