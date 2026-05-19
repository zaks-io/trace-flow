import { PROVIDERS as PROVIDER_ADAPTERS } from './providers';
import type { Provider, ResolvedRoute } from './providers/types';
import type { ProviderId } from './types';

/**
 * Public listing of all Providers. Each entry is the full Provider adapter
 * (token schema, request/response/SSE parsers), keyed by id. Use
 * `Object.keys(PROVIDERS)` for validation messages and `PROVIDERS[id]` to
 * fetch an adapter directly.
 */
export const PROVIDERS: Record<ProviderId, Provider> = PROVIDER_ADAPTERS;

const ROUTE_PATTERN = /^\/([^/]+)(\/.*)?$/;

export function resolveRoute(path: string): ResolvedRoute | null {
  const match = ROUTE_PATTERN.exec(path);
  if (!match?.[1]) return null;

  const providerId = match[1].toLowerCase() as ProviderId;
  const provider = PROVIDERS[providerId];
  if (!provider) return null;

  const remainingPath = match[2] ?? '';

  return {
    provider,
    targetUrl: `${provider.baseUrl}${remainingPath}`,
  };
}
