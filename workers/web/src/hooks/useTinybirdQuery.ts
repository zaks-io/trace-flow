import { useState, useEffect, useCallback, useRef } from 'react';
import { useAction } from 'convex/react';
import { api } from '../../../../convex/_generated/api';

class TinybirdAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TinybirdAuthError';
  }
}

interface TinybirdScope {
  type: string;
  resource: string;
  fixed_params?: Record<string, unknown>;
}

interface UseTinybirdQueryOptions {
  sql: string;
  scopes: TinybirdScope[];
  params?: Record<string, unknown>;
  ttl?: number;
  enabled?: boolean;
  pollInterval?: number;
  apiKeys?: string[];
}

function buildApiKeyFilter(apiKeys: string[]): string {
  if (apiKeys.length === 0) return '';
  const escaped = apiKeys.map((k) => `'${k.replace(/'/g, "''")}'`).join(', ');
  return `ApiKey IN (${escaped})`;
}

function injectApiKeyFilter(sql: string, apiKeys: string[] | undefined): string {
  if (!apiKeys || apiKeys.length === 0) return sql;

  const filter = buildApiKeyFilter(apiKeys);
  const upperSql = sql.toUpperCase();

  const whereIndex = upperSql.indexOf('WHERE');
  const fromIndex = upperSql.indexOf('FROM');
  const orderByIndex = upperSql.indexOf('ORDER BY');
  const groupByIndex = upperSql.indexOf('GROUP BY');
  const limitIndex = upperSql.indexOf('LIMIT');
  const formatIndex = upperSql.indexOf('FORMAT');

  if (whereIndex !== -1) {
    const insertPos = whereIndex + 6;
    return `${sql.slice(0, insertPos)}${filter} AND ${sql.slice(insertPos)}`;
  }

  let insertPos = sql.length;
  if (formatIndex !== -1) insertPos = Math.min(insertPos, formatIndex);
  if (limitIndex !== -1) insertPos = Math.min(insertPos, limitIndex);
  if (orderByIndex !== -1) insertPos = Math.min(insertPos, orderByIndex);
  if (groupByIndex !== -1) insertPos = Math.min(insertPos, groupByIndex);

  if (insertPos === sql.length && fromIndex !== -1) {
    const afterFrom = sql.slice(fromIndex + 4);
    const tableMatch = /^\s+\S+/.exec(afterFrom);
    if (tableMatch) {
      insertPos = fromIndex + 4 + tableMatch[0].length;
    }
  }

  return `${sql.slice(0, insertPos)} WHERE ${filter}${sql.slice(insertPos)}`;
}

interface TinybirdQueryResult<T = unknown> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function useTinybirdQuery<T = unknown>(
  options: UseTinybirdQueryOptions,
): TinybirdQueryResult<T> {
  // Only run query when we have API keys to filter by
  const apiKeysLoading = options.apiKeys === undefined;
  const hasApiKeys = Array.isArray(options.apiKeys) && options.apiKeys.length > 0;
  const noApiKeys = !apiKeysLoading && !hasApiKeys;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(!noApiKeys);
  const [error, setError] = useState<Error | null>(null);
  const [jwt, setJwt] = useState<string | null>(null);
  const hasFetchedRef = useRef(false);

  const generateToken = useAction(api.tinybird.generateToken);
  const enabled = (options.enabled ?? true) && hasApiKeys;

  const fetchToken = useCallback(async () => {
    const result = await generateToken({
      scopes: options.scopes,
      ttl: options.ttl,
    });
    setJwt(result.token);
    return result.token;
  }, [generateToken, options.scopes, options.ttl]);

  const fetchData = useCallback(
    async (token: string) => {
      const apiUrl = import.meta.env.NEXT_PUBLIC_TINYBIRD_API_URL ?? 'https://api.tinybird.co';
      const url = new URL(`${apiUrl}/v0/sql`);

      const filteredSql = injectApiKeyFilter(options.sql, options.apiKeys);
      url.searchParams.set('q', filteredSql);

      if (options.params) {
        Object.entries(options.params).forEach(([key, value]) => {
          url.searchParams.set(key, String(value));
        });
      }

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        const message = `Tinybird query failed: ${response.status} - ${errorText}`;

        if (response.status === 403) {
          throw new TinybirdAuthError(message);
        }
        throw new Error(message);
      }

      return response.json();
    },
    [options.sql, options.params, options.apiKeys],
  );

  const refetch = useCallback(async () => {
    if (!enabled) return;

    setLoading(true);
    setError(null);

    try {
      const currentToken = jwt ?? (await fetchToken());
      const result = await fetchData(currentToken);
      setData(result as T);
      setError(null);
    } catch (err) {
      // On auth error, clear token and retry once with fresh token
      if (err instanceof TinybirdAuthError && jwt !== null) {
        setJwt(null);
        try {
          const freshToken = await fetchToken();
          const result = await fetchData(freshToken);
          setData(result as T);
          setError(null);
          return;
        } catch (retryErr) {
          setError(retryErr instanceof Error ? retryErr : new Error(String(retryErr)));
          setData(null);
          return;
        }
      }

      setError(err instanceof Error ? err : new Error(String(err)));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [enabled, jwt, fetchToken, fetchData]);

  // Track SQL to detect changes
  const prevSqlRef = useRef(options.sql);

  useEffect(() => {
    if (!hasFetchedRef.current && enabled) {
      hasFetchedRef.current = true;
      void refetch();
    }
  }, [enabled, refetch]);

  // Refetch when SQL changes
  useEffect(() => {
    if (prevSqlRef.current !== options.sql && enabled && hasFetchedRef.current) {
      prevSqlRef.current = options.sql;
      void refetch();
    }
  }, [options.sql, enabled, refetch]);

  // When API keys load as empty, set loading to false immediately
  useEffect(() => {
    if (noApiKeys) {
      setLoading(false);
    }
  }, [noApiKeys]);

  // Set up polling when pollInterval is provided
  // Stop polling if there's an error
  useEffect(() => {
    if (!enabled || !options.pollInterval || options.pollInterval <= 0) {
      return;
    }

    // Don't start polling if there's already an error
    if (error) {
      return;
    }

    const intervalId = setInterval(() => {
      // Check error state before each poll - stop if error occurred
      // We can't directly access error state here, so we'll rely on the effect
      // being re-run when error changes
      void refetch();
    }, options.pollInterval);

    return () => {
      clearInterval(intervalId);
    };
  }, [enabled, options.pollInterval, refetch, error]);

  return { data, loading, error, refetch };
}
