import type { ProviderConfig, ProviderId, ResolvedRoute } from './types';

export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  openai: { id: 'openai', baseUrl: 'https://api.openai.com' },
  anthropic: { id: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  openrouter: { id: 'openrouter', baseUrl: 'https://openrouter.ai/api' },
  groq: { id: 'groq', baseUrl: 'https://api.groq.com/openai' },
  google: { id: 'google', baseUrl: 'https://generativelanguage.googleapis.com' },
};

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
