'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clearTokenCache } from '@/lib/tinybird';

// Refresh token 60 seconds before expiry to prevent failed requests
const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;
// Refresh token if user returns after being hidden for 5 minutes
const VISIBILITY_REFRESH_THRESHOLD_MS = 5 * 60 * 1000;
// Maximum retry attempts for proactive refresh before giving up
const MAX_REFRESH_ATTEMPTS = 3;
// Reset retry counter after this duration to recover from transient outages
const RETRY_RESET_MS = 5 * 60 * 1000;
// Heartbeat interval for wake-from-sleep detection (30 seconds)
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
// Time gap that indicates wake from sleep (2 minutes when expecting 30s)
const SLEEP_DETECTION_THRESHOLD_MS = 2 * 60 * 1000;
// Delay before retrying a 401 after wake-from-sleep (cookies/network settling)
const WAKE_RETRY_DELAY_MS = 2000;

type TokenResponse = { token: string; expiresAt: number | null };

async function parseTokenResponse(response: Response): Promise<TokenResponse | null> {
  try {
    const data = (await response.json()) as unknown;
    if (
      data &&
      typeof data === 'object' &&
      'token' in data &&
      typeof (data as TokenResponse).token === 'string'
    ) {
      return data as TokenResponse;
    }
    return null;
  } catch {
    return null;
  }
}

export function useConvexAuthSession() {
  // Routes are server-protected by middleware, so assume authenticated on mount.
  // Starting with isAuthenticated=false would cause Convex to skip queries,
  // which means fetchAccessToken never fires — a deadlock.
  const [isAuthenticated, setIsAuthenticated] = useState(true);

  const tokenExpiresAtRef = useRef<number | null>(null);
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastVisibleRef = useRef<number>(Date.now());
  const refreshAttemptRef = useRef<number>(0);
  const lastRefreshFailureRef = useRef<number>(0);
  const redirectingToLoginRef = useRef(false);
  const isMountedRef = useRef(true);
  const inFlightRef = useRef<{
    promise: Promise<string | null>;
    force: boolean;
  } | null>(null);

  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
      // Deduplicate: reuse in-flight if not forcing, or if in-flight is already forced
      if (inFlightRef.current && (!forceRefreshToken || inFlightRef.current.force)) {
        return inFlightRef.current.promise;
      }

      const shouldForceRefreshEndpoint =
        forceRefreshToken &&
        (tokenExpiresAtRef.current === null ||
          tokenExpiresAtRef.current - Date.now() <= TOKEN_REFRESH_BUFFER_MS);

      const run = async () => {
        if (forceRefreshToken) {
          // Reset retry counter after a cooldown so transient outages don't permanently block refreshes
          if (
            refreshAttemptRef.current >= MAX_REFRESH_ATTEMPTS &&
            Date.now() - lastRefreshFailureRef.current > RETRY_RESET_MS
          ) {
            refreshAttemptRef.current = 0;
          }
          if (refreshAttemptRef.current >= MAX_REFRESH_ATTEMPTS) {
            console.warn('Max token refresh attempts reached');
            return null;
          }
        }

        const url = shouldForceRefreshEndpoint ? '/api/token?forceRefresh=1' : '/api/token';
        const response = await fetch(url, { cache: 'no-store' });

        if (!response.ok) {
          if (response.status === 401) {
            // After wake-from-sleep, cookies/network may not be ready yet.
            // Retry once after a delay before falling through to a full redirect.
            await new Promise((r) => setTimeout(r, WAKE_RETRY_DELAY_MS));
            const retryResponse = await fetch('/api/token', { cache: 'no-store' });
            if (retryResponse.ok) {
              refreshAttemptRef.current = 0;
              const retryData = await parseTokenResponse(retryResponse);
              return retryData?.token ?? null;
            }

            if (!isMountedRef.current) return null;
            clearTokenCache();
            setIsAuthenticated(false);
            if (!redirectingToLoginRef.current) {
              redirectingToLoginRef.current = true;
              const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
              window.location.href = `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
            }
            return null;
          }

          // Non-401 errors (500, network) are transient — don't change auth state
          return null;
        }

        // Reset retry counter on success
        refreshAttemptRef.current = 0;
        if (isMountedRef.current) setIsAuthenticated(true);

        const data = await parseTokenResponse(response);
        if (!data) return null;

        // Schedule proactive refresh before token expires.
        // Bail if unmounted — scheduling a new timer here would leak since cleanup already ran.
        if (data.expiresAt && isMountedRef.current) {
          const expiresAtMs = data.expiresAt * 1000;
          tokenExpiresAtRef.current = expiresAtMs;

          if (refreshTimeoutRef.current) {
            clearTimeout(refreshTimeoutRef.current);
          }

          const timeUntilRefresh = expiresAtMs - Date.now() - TOKEN_REFRESH_BUFFER_MS;
          if (timeUntilRefresh > 0) {
            refreshTimeoutRef.current = setTimeout(() => {
              void fetchAccessToken({ forceRefreshToken: true });
            }, timeUntilRefresh);
          }
        }

        return data.token;
      };

      const promise = run()
        .catch((error) => {
          if (forceRefreshToken) {
            refreshAttemptRef.current++;
            lastRefreshFailureRef.current = Date.now();
          }
          console.error('Error fetching access token:', error);
          return null;
        })
        .finally(() => {
          inFlightRef.current = null;
        });

      inFlightRef.current = { promise, force: forceRefreshToken };

      return promise;
    },
    [],
  );

  // Refresh token when user returns to tab after being away
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        lastVisibleRef.current = Date.now();
      } else {
        const hiddenDuration = Date.now() - lastVisibleRef.current;
        if (hiddenDuration > VISIBILITY_REFRESH_THRESHOLD_MS) {
          void fetchAccessToken({ forceRefreshToken: true });
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [fetchAccessToken]);

  // Cleanup scheduled refresh on unmount and prevent post-unmount timer scheduling
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (refreshTimeoutRef.current) {
        clearTimeout(refreshTimeoutRef.current);
      }
    };
  }, []);

  // Detect wake from sleep using heartbeat.
  // Visibility detection doesn't catch sleep because document is never "hidden".
  // setTimeout pauses during sleep, so scheduled refreshes don't fire.
  // Both this and visibilitychange may fire on wake — inFlightRef dedup handles it.
  useEffect(() => {
    let lastHeartbeat = Date.now();

    const heartbeat = setInterval(() => {
      const now = Date.now();
      const elapsed = now - lastHeartbeat;

      if (elapsed > SLEEP_DETECTION_THRESHOLD_MS) {
        void fetchAccessToken({ forceRefreshToken: true });
      }

      lastHeartbeat = now;
    }, HEARTBEAT_INTERVAL_MS);

    return () => clearInterval(heartbeat);
  }, [fetchAccessToken]);

  return useMemo(
    () => ({
      isLoading: false as const,
      isAuthenticated,
      fetchAccessToken,
    }),
    [isAuthenticated, fetchAccessToken],
  );
}
