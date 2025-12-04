import { useQuery } from 'convex/react';
import { api } from '../../../../../convex/_generated/api';

export default function Dashboard() {
  const apiKeys = useQuery(api.apiKeys.list);

  return (
    <div className="animate-fade-in">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">Request Analytics Dashboard</p>
      </div>

      <div className="card-elevated rounded-xl border border-border bg-card p-6">
        <h2 className="mb-4 text-base font-medium text-foreground">API Keys</h2>
        {apiKeys === undefined ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            Loading...
          </div>
        ) : apiKeys.length === 0 ? (
          <p className="text-sm text-muted-foreground">No API keys found</p>
        ) : (
          <div className="stagger-children space-y-2">
            {apiKeys.map((apiKey) => (
              <div
                key={apiKey._id}
                className="rounded-lg border border-border bg-muted/30 p-3 transition-colors hover:bg-muted/50"
              >
                <p className="text-sm">
                  <span className="text-muted-foreground">Key:</span>{' '}
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                    {apiKey.key}
                  </code>
                </p>
                <p className="mt-1.5 text-sm">
                  <span className="text-muted-foreground">Expires:</span>{' '}
                  <span className="text-foreground">
                    {new Date(apiKey.expiresAt).toLocaleString()}
                  </span>
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
