export const DEFAULT_API_KEY_NAME = 'Default API Key';

export type ApiKeyLike<TId = unknown> = {
  _id: TId;
  _creationTime: number;
  expiresAt: number;
  key: string;
  name?: string;
};

export function isApiKeyActive(apiKey: Pick<ApiKeyLike, 'expiresAt'>, now = Date.now()): boolean {
  return apiKey.expiresAt > now;
}

export function sortApiKeys<T extends ApiKeyLike>(apiKeys: readonly T[]): T[] {
  return [...apiKeys].sort((a, b) => {
    const nameA = a.name ?? '';
    const nameB = b.name ?? '';
    if (nameA !== nameB) {
      if (!nameA) return 1;
      if (!nameB) return -1;
      return nameA.localeCompare(nameB);
    }
    return a._creationTime - b._creationTime;
  });
}

export function getPrimaryApiKey<T extends ApiKeyLike>(apiKeys: readonly T[]): T | null {
  const sortedKeys = sortApiKeys(apiKeys).filter((apiKey) => isApiKeyActive(apiKey));
  return sortedKeys.find((apiKey) => apiKey.name === DEFAULT_API_KEY_NAME) ?? sortedKeys[0] ?? null;
}
