import type { ApiKeyPermission } from '@trace-flow/convex/apiKeyPermissions';

type ApiKeyAccessFieldsProps = {
  permissions: readonly ApiKeyPermission[];
  onChange: (permissions: ApiKeyPermission[]) => void;
  disabled?: boolean;
};

export function ApiKeyAccessFields({ permissions, onChange, disabled }: ApiKeyAccessFieldsProps) {
  const setPermission = (permission: ApiKeyPermission, checked: boolean) => {
    onChange(
      checked
        ? [...permissions, permission]
        : permissions.filter((selected) => selected !== permission),
    );
  };

  return (
    <fieldset disabled={disabled} className="space-y-2">
      <legend className="mb-2 text-sm font-medium text-foreground">Access</legend>
      <div className="space-y-3 rounded-lg border border-border p-3">
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={permissions.includes('ingest')}
              onChange={(event) => setPermission('ingest', event.target.checked)}
            />
            <span>Send traces</span>
          </label>
          <p className="text-xs text-muted-foreground">
            Send traces and usage from your apps and model API requests.
          </p>
        </div>
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={permissions.includes('mcp:read')}
              onChange={(event) => setPermission('mcp:read', event.target.checked)}
            />
            <span>MCP read access</span>
          </label>
          <p className="text-xs text-muted-foreground">
            Read all organization traces, usage, and coding-agent analytics. MCP tools only read
            data.
          </p>
        </div>
      </div>
      {permissions.length === 0 && (
        <p className="text-xs text-muted-foreground">Choose at least one access option.</p>
      )}
    </fieldset>
  );
}
