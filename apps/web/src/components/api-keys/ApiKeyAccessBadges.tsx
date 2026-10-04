import { apiKeyPermissions, type ApiKeyPermission } from '@trace-flow/convex/apiKeyPermissions';

const accessLabels: Record<ApiKeyPermission, string> = {
  ingest: 'Send traces',
  'mcp:read': 'MCP read access',
};

export function ApiKeyAccessBadges({
  apiKey,
}: {
  apiKey: { permissions?: readonly ApiKeyPermission[] };
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {apiKeyPermissions(apiKey).map((permission) => (
        <span
          key={permission}
          className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted px-2 py-1 text-xs text-muted-foreground"
        >
          {accessLabels[permission]}
        </span>
      ))}
    </div>
  );
}
