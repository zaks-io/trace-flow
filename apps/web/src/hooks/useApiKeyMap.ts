import { useMemo } from 'react';

interface ApiKey {
  identifier: string;
  name?: string | null;
}

export function useApiKeyMap(apiKeys: ApiKey[] | undefined): Map<string, string> {
  return useMemo(() => {
    return new Map(
      apiKeys?.map((apiKey) => [
        apiKey.identifier,
        apiKey.name ?? `Unnamed API key (${apiKey.identifier.slice(-6)})`,
      ]) ?? [],
    );
  }, [apiKeys]);
}
