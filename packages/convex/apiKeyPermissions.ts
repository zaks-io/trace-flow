import { v, type Infer } from 'convex/values';

export const apiKeyPermissionValidator = v.union(v.literal('ingest'), v.literal('mcp:read'));
export type ApiKeyPermission = Infer<typeof apiKeyPermissionValidator>;

export function apiKeyPermissions(key: {
  permissions?: readonly ApiKeyPermission[];
}): readonly ApiKeyPermission[] {
  // Keys created before permissions existed only authorized ingestion.
  return key.permissions ?? ['ingest'];
}

export function hasApiKeyPermission(
  key: { permissions?: readonly ApiKeyPermission[] },
  permission: ApiKeyPermission,
): boolean {
  return apiKeyPermissions(key).includes(permission);
}
