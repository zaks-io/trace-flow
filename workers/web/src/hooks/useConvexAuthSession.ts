'use client';

import { useCallback, useMemo } from 'react';

/**
 * Custom auth hook for Convex integration in the app.
 * App routes are server-protected, so we assume authenticated state.
 * Implements the interface expected by ConvexProviderWithAuth:
 * - isLoading: boolean
 * - isAuthenticated: boolean
 * - fetchAccessToken: ({ forceRefreshToken }) => Promise<string | null>
 *
 * Uses on-demand token fetching via /api/token endpoint.
 */
export function useConvexAuthSession() {
  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
      try {
        const url = forceRefreshToken ? '/api/token?forceRefresh=1' : '/api/token';
        const response = await fetch(url, {
          cache: forceRefreshToken ? 'no-store' : 'default',
        });

        if (!response.ok) {
          if (response.status === 401) {
            // User needs to re-authenticate
            window.location.href = `/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`;
            return null;
          }
          return null;
        }

        const data = await response.json();
        return data.token;
      } catch (error) {
        console.error('Error fetching access token:', error);
        return null;
      }
    },
    [],
  );

  return useMemo(
    () => ({
      isLoading: false, // App is server-protected, so we're always authenticated
      isAuthenticated: true,
      fetchAccessToken,
    }),
    [fetchAccessToken],
  );
}
