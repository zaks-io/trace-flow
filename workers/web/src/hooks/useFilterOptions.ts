import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAction } from 'convex/react';
import { api } from '../../../../convex/_generated/api';

export interface FilterOptions {
  providers: string[];
  models: string[];
  statuses: string[];
}

interface UseFilterOptionsResult {
  options: FilterOptions;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function buildApiKeyFilter(apiKeys: string[]): string {
  if (apiKeys.length === 0) return '';
  const escaped = apiKeys.map((k) => `'${k.replace(/'/g, "''")}'`).join(', ');
  return `ApiKey IN (${escaped})`;
}

export function useFilterOptions(apiKeys: string[] | undefined): UseFilterOptionsResult {
  const apiKeysLoading = apiKeys === undefined;
  const hasApiKeys = Array.isArray(apiKeys) && apiKeys.length > 0;

  const [options, setOptions] = useState<FilterOptions>({
    providers: [],
    models: [],
    statuses: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [jwt, setJwt] = useState<string | null>(null);
  const lastFetchRef = useRef<number>(0);
  const hasFetchedRef = useRef(false);

  const generateToken = useAction(api.tinybird.generateToken);

  const fetchToken = useCallback(async () => {
    const result = await generateToken({
      scopes: [{ type: 'PIPES:READ', resource: 'otel_traces' }],
      ttl: 600,
    });
    setJwt(result.token);
    return result.token;
  }, [generateToken]);

  const fetchDistinctValues = useCallback(async (token: string, sql: string): Promise<string[]> => {
    const apiUrl = import.meta.env.NEXT_PUBLIC_TINYBIRD_API_URL ?? 'https://api.tinybird.co';
    const url = new URL(`${apiUrl}/v0/sql`);
    url.searchParams.set('q', sql);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Tinybird query failed: ${response.status} - ${errorText}`);
    }

    const result: { data: { value: string }[] } = await response.json();
    return result.data.map((row) => row.value).filter(Boolean);
  }, []);

  const apiKeyFilter = useMemo(() => {
    if (!hasApiKeys || !apiKeys) return '';
    return buildApiKeyFilter(apiKeys);
  }, [hasApiKeys, apiKeys]);

  const refetch = useCallback(async () => {
    if (!hasApiKeys || !apiKeyFilter) return;

    // Check cache TTL
    const now = Date.now();
    if (now - lastFetchRef.current < CACHE_TTL_MS && hasFetchedRef.current) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const token = jwt ?? (await fetchToken());

      const providersSql = `
        SELECT DISTINCT JSONExtractString(SpanAttributes, 'ai.provider') as value
        FROM otel_traces
        WHERE SpanName = 'ai.request' AND ${apiKeyFilter} AND value != ''
        ORDER BY value
        LIMIT 100
        FORMAT JSON
      `;

      const modelsSql = `
        SELECT DISTINCT JSONExtractString(SpanAttributes, 'ai.model') as value
        FROM otel_traces
        WHERE SpanName = 'ai.request' AND ${apiKeyFilter} AND value != ''
        ORDER BY value
        LIMIT 100
        FORMAT JSON
      `;

      const statusesSql = `
        SELECT DISTINCT StatusCode as value
        FROM otel_traces
        WHERE SpanName = 'ai.request' AND ${apiKeyFilter}
        ORDER BY value
        FORMAT JSON
      `;

      const [providers, models, statuses] = await Promise.all([
        fetchDistinctValues(token, providersSql),
        fetchDistinctValues(token, modelsSql),
        fetchDistinctValues(token, statusesSql),
      ]);

      setOptions({ providers, models, statuses });
      lastFetchRef.current = now;
      hasFetchedRef.current = true;
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [hasApiKeys, apiKeyFilter, jwt, fetchToken, fetchDistinctValues]);

  // Initial fetch
  useEffect(() => {
    if (!apiKeysLoading && hasApiKeys && !hasFetchedRef.current) {
      void refetch();
    }
  }, [apiKeysLoading, hasApiKeys, refetch]);

  // Set loading to false if no API keys
  useEffect(() => {
    if (!apiKeysLoading && !hasApiKeys) {
      setLoading(false);
    }
  }, [apiKeysLoading, hasApiKeys]);

  return {
    options,
    loading,
    error,
    refetch,
  };
}
