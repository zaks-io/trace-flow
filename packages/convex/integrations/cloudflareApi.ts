// Self-Contained Local Workers read miniflare KV, which Cloudflare's API cannot reach,
// so scripts/dev/local-stack.sh points this at a local stand-in (scripts/dev/kv-bridge.ts).
export function cloudflareKvValuesUrl(accountId: string, namespaceId: string): string {
  const apiBaseUrl = process.env.CLOUDFLARE_API_BASE_URL ?? 'https://api.cloudflare.com/client/v4';
  return `${apiBaseUrl}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values`;
}
