import { useMemo } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';

function truncateKey(key: string): string {
  if (key.length <= 12) return key;
  return `${key.slice(0, 5)}...${key.slice(-5)}`;
}

export function useApiKeyMap(): Map<string, string> {
  const apiKeys = useQuery(api.apiKeys.list);

  return useMemo(() => {
    const map = new Map<string, string>();
    if (!apiKeys) return map;
    for (const ak of apiKeys) {
      map.set(ak.key, ak.name ?? truncateKey(ak.key));
    }
    return map;
  }, [apiKeys]);
}
