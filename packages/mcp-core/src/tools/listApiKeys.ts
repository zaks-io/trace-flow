import type { ToolCallResult } from '../protocol';
import type { McpApiKeyMeta } from '../backend';

/**
 * Pure formatter for the `list_api_keys` tool. Takes already-fetched key
 * metadata (the backend owns the lookup) and returns the public-safe view:
 * id + name + expiry, never the raw key value.
 */
export function listApiKeys(apiKeys: McpApiKeyMeta[]): ToolCallResult {
  const now = Date.now();
  const keys = apiKeys
    .filter((k) => k.expiresAt > now)
    .map((k) => ({
      id: k.id,
      name: k.name ?? 'Unnamed key',
      expires_at: new Date(k.expiresAt).toISOString(),
    }));

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ api_keys: keys, total: keys.length }),
      },
    ],
  };
}
