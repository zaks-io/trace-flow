'use client';

import { normalizeAnalyticsKey } from '@trace-flow/utils';
import { useEffect, useState } from 'react';

interface ResolvedFilter {
  source: string | null;
  identifier: string | null;
  error: Error | null;
}

export function useAnalyticsKeyFilter(value: string | null): {
  identifier: string | null;
  error: Error | null;
} {
  const [resolved, setResolved] = useState<ResolvedFilter>({
    source: null,
    identifier: null,
    error: null,
  });

  useEffect(() => {
    let active = true;

    const resolve = value ? normalizeAnalyticsKey(value) : Promise.resolve(null);
    void resolve
      .then((identifier) => {
        if (active) setResolved({ source: value, identifier, error: null });
      })
      .catch((error: unknown) => {
        if (active) {
          setResolved({
            source: value,
            identifier: null,
            error: error instanceof Error ? error : new Error('Failed to secure API key filter'),
          });
        }
      });

    return () => {
      active = false;
    };
  }, [value]);

  if (resolved.source !== value) return { identifier: null, error: null };
  return { identifier: resolved.identifier, error: resolved.error };
}
