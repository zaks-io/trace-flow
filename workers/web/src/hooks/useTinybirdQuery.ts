import { useState, useEffect, useCallback, useRef } from 'react';
import { useAction } from 'convex/react';
import { api } from '../../../../convex/_generated/api';

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
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [jwt, setJwt] = useState<string | null>(null);
  const hasFetchedRef = useRef(false);

  const generateToken = useAction(api.tinybirdJwt.generateToken);
  const enabled = options.enabled ?? true;

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
      const apiUrl = process.env.NEXT_PUBLIC_TINYBIRD_API_URL ?? 'https://api.tinybird.co';
      const url = new URL(`${apiUrl}/v0/sql`);

      url.searchParams.set('q', options.sql);

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
        throw new Error(
          `Tinybird query failed: ${response.status} ${response.statusText} - ${errorText}`,
        );
      }

      return response.json();
    },
    [options.sql, options.params],
  );

  const refetch = useCallback(async () => {
    if (!enabled) return;

    setLoading(true);
    setError(null);

    const currentToken = jwt ?? (await fetchToken());

    fetchData(currentToken)
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err : new Error(String(err)));
        setData(null);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [enabled, jwt, fetchToken, fetchData]);

  useEffect(() => {
    if (!hasFetchedRef.current && enabled) {
      hasFetchedRef.current = true;
      void refetch();
    }
  }, [enabled, refetch]);

  return { data, loading, error, refetch };
}
