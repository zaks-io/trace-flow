import { useEffect, useRef } from 'react';
import { useConvexAuth, useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';

export function useUserInitialization() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const initializeUser = useMutation(api.auth.users.initializeUser);
  const isInitializing = useRef(false);

  useEffect(() => {
    if (isAuthenticated && !isLoading && !isInitializing.current) {
      isInitializing.current = true;
      initializeUser().catch(() => {
        isInitializing.current = false;
      });
    }
  }, [isAuthenticated, isLoading, initializeUser]);
}
