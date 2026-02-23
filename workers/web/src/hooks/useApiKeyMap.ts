import { useMemo } from 'react';

function truncateKey(key: string): string {
  if (key.length <= 12) return key;
  return `${key.slice(0, 5)}...${key.slice(-5)}`;
}

export function useApiKeyMap(
  apiKeys: { key: string; name?: string | null }[] | undefined,
): Map<string, string> {
  return useMemo(() => {
    const map = new Map<string, string>();
    if (!apiKeys) return map;
    for (const ak of apiKeys) {
      map.set(ak.key, ak.name ?? truncateKey(ak.key));
    }
    return map;
  }, [apiKeys]);
}
