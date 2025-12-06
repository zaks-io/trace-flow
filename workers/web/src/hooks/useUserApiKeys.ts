import { useMemo } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../../../convex/_generated/api';

export function useUserApiKeys(): { keys: string[] | undefined; isLoading: boolean } {
  const apiKeys = useQuery(api.apiKeys.list);
  const keys = useMemo(() => apiKeys?.map((k) => k.key), [apiKeys]);
  return { keys, isLoading: apiKeys === undefined };
}
