import { useState, useEffect, useCallback, useRef } from 'react';
import { useAction } from 'convex/react';
import { api } from '@convex/_generated/api';

class TinybirdAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TinybirdAuthError';
  }
}

interface UseTinybirdPipeOptions<T> {
  pipe: string;
  params?: Record<string, string | number | boolean | undefined>;
  ttl?: number;
  enabled?: boolean;
  pollInterval?: number;
  transform?: (data: unknown) => T;
}

interface TinybirdPipeResult<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function useTinybirdPipe<T = unknown>(
  options: UseTinybirdPipeOptions<T>,
): TinybirdPipeResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [jwt, setJwt] = useState<string | null>(null);
  const hasFetchedRef = useRef(false);

  const generateToken = useAction(api.tinybird.generateToken);
  const enabled = options.enabled ?? true;

  const fetchToken = useCallback(async () => {
    const result = await generateToken({
      scopes: [{ type: 'PIPES:READ', resource: options.pipe }],
      ttl: options.ttl,
    });
    setJwt(result.token);
    return result.token;
  }, [generateToken, options.pipe, options.ttl]);

  const fetchData = useCallback(
    async (token: string) => {
      const apiUrl = import.meta.env.NEXT_PUBLIC_TINYBIRD_API_URL ?? 'https://api.tinybird.co';
      const url = new URL(`${apiUrl}/v0/pipes/${options.pipe}.json`);

      // Add query parameters (excluding undefined values)
      if (options.params) {
        Object.entries(options.params).forEach(([key, value]) => {
          if (value !== undefined) {
            url.searchParams.set(key, String(value));
          }
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
        const message = `Tinybird pipe query failed: ${response.status} - ${errorText}`;

        if (response.status === 403) {
          throw new TinybirdAuthError(message);
        }
        throw new Error(message);
      }

      const result = await response.json();
      return options.transform ? options.transform(result) : result;
    },
    [options.pipe, options.params, options.transform],
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

  // Track pipe and params to detect changes
  const prevPipeRef = useRef(options.pipe);
  const prevParamsRef = useRef(JSON.stringify(options.params));

  useEffect(() => {
    if (!hasFetchedRef.current && enabled) {
      hasFetchedRef.current = true;
      void refetch();
    }
  }, [enabled, refetch]);

  // Refetch when pipe or params change
  useEffect(() => {
    const currentParams = JSON.stringify(options.params);
    if (
      (prevPipeRef.current !== options.pipe || prevParamsRef.current !== currentParams) &&
      enabled &&
      hasFetchedRef.current
    ) {
      prevPipeRef.current = options.pipe;
      prevParamsRef.current = currentParams;
      void refetch();
    }
  }, [options.pipe, options.params, enabled, refetch]);

  // Set up polling when pollInterval is provided
  useEffect(() => {
    if (!enabled || !options.pollInterval || options.pollInterval <= 0 || error) {
      return;
    }

    const intervalId = setInterval(() => {
      void refetch();
    }, options.pollInterval);

    return () => {
      clearInterval(intervalId);
    };
  }, [enabled, options.pollInterval, refetch, error]);

  return { data, loading, error, refetch };
}
