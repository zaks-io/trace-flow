import { useEffect, useRef } from 'react';
import { useConvexAuth, useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';

export function useInitializeUser() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const initializeUser = useMutation(api.users.initializeUser);
  const hasInitialized = useRef(false);

  useEffect(() => {
    if (isAuthenticated && !isLoading && !hasInitialized.current) {
      hasInitialized.current = true;
      void initializeUser();
    }
  }, [isAuthenticated, isLoading, initializeUser]);
}
