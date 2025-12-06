import { useQuery, useMutation, useAction } from 'convex/react';
import { api } from '../../../../../convex/_generated/api';
import { useState } from 'react';
import type { Id } from '../../../../../convex/_generated/dataModel';
import { usePageHeader } from '@/components/PageHeaderContext';

export default function ApiKeys() {
  usePageHeader('API Keys');
  const apiKeys = useQuery(api.apiKeys.list);
  const createApiKey = useMutation(api.apiKeys.create);
  const deleteApiKey = useMutation(api.apiKeys.remove);
  const syncToKV = useAction(api.apiKeys.syncToKV);

  const [isCreating, setIsCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<Id<'apiKeys'> | null>(null);
  const [syncingId, setSyncingId] = useState<Id<'apiKeys'> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleCreateKey = async () => {
    setIsCreating(true);
    setError(null);
    setSuccess(null);

    const expiresAt = Date.now() + 90 * 24 * 60 * 60 * 1000;

    await createApiKey({ expiresAt });
    setSuccess('API key created successfully');
    setIsCreating(false);
  };

  const handleDeleteKey = async (id: Id<'apiKeys'>) => {
    setDeletingId(id);
    setError(null);
    setSuccess(null);

    await deleteApiKey({ id });
    setSuccess('API key deleted successfully');
    setDeletingId(null);
  };

  const handleSyncKey = async (id: Id<'apiKeys'>) => {
    setSyncingId(id);
    setError(null);
    setSuccess(null);

    const result = await syncToKV({ id });
    if (result.existed) {
      setSuccess('API key already exists in KV');
    } else {
      setSuccess('API key synced to KV');
    }
    setSyncingId(null);
  };

  const formatExpiration = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = Date.now();
    const isExpired = timestamp < now;

    return {
      formatted: date.toLocaleString(),
      isExpired,
    };
  };

  const isExpiringSoon = (timestamp: number) => {
    const now = Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    return timestamp - now < sevenDays && timestamp > now;
  };

  return (
    <div className="animate-fade-in">
      <div className="mb-6 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Manage your API keys for accessing the proxy service
        </p>
        <button
          onClick={() => void handleCreateKey()}
          disabled={isCreating}
          className="inline-flex items-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-all hover:bg-primary/90 hover:shadow-md hover:shadow-primary/20 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isCreating ? (
            <>
              <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
              Creating...
            </>
          ) : (
            'Create API Key'
          )}
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-destructive/50 bg-destructive/10 p-4">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {success && (
        <div className="mb-4 rounded-xl border border-emerald-500/50 bg-emerald-500/10 p-4">
          <p className="text-sm text-emerald-400">{success}</p>
        </div>
      )}

      {apiKeys === undefined ? (
        <div className="flex items-center justify-center py-12">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            Loading API keys...
          </div>
        </div>
      ) : apiKeys.length === 0 ? (
        <div className="card-elevated rounded-xl border border-border bg-card p-12 text-center">
          <p className="text-muted-foreground">No API keys found</p>
          <p className="mt-1 text-sm text-muted-foreground/70">
            Create your first API key to get started
          </p>
        </div>
      ) : (
        <div className="card-elevated overflow-hidden rounded-xl border border-border bg-card">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-border">
              <thead className="bg-muted/30">
                <tr>
                  <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    API Key
                  </th>
                  <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Expiration Date
                  </th>
                  <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Status
                  </th>
                  <th className="px-6 py-3.5 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border bg-card">
                {apiKeys.map((apiKey) => {
                  const { formatted, isExpired } = formatExpiration(apiKey.expiresAt);
                  const expiringSoon = isExpiringSoon(apiKey.expiresAt);

                  return (
                    <tr key={apiKey._id} className="table-row-interactive">
                      <td className="whitespace-nowrap px-6 py-4 text-sm">
                        <code className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-xs text-foreground">
                          {apiKey.key}
                        </code>
                      </td>
                      <td className="whitespace-nowrap px-6 py-4 text-sm text-foreground">
                        {formatted}
                      </td>
                      <td className="whitespace-nowrap px-6 py-4">
                        {isExpired ? (
                          <span className="inline-flex items-center rounded-full bg-destructive/20 px-2 py-0.5 text-xs font-medium text-destructive">
                            Expired
                          </span>
                        ) : expiringSoon ? (
                          <span className="inline-flex items-center rounded-full bg-yellow-500/20 px-2 py-0.5 text-xs font-medium text-yellow-400">
                            Expiring Soon
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs font-medium text-emerald-400">
                            Active
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-6 py-4 text-right text-sm">
                        <button
                          onClick={() => void handleSyncKey(apiKey._id)}
                          disabled={syncingId === apiKey._id}
                          className="mr-3 font-medium text-primary transition-colors hover:text-primary/80 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {syncingId === apiKey._id ? 'Syncing...' : 'Sync'}
                        </button>
                        <button
                          onClick={() => {
                            if (
                              confirm(
                                `Are you sure you want to delete this API key?\n\n${apiKey.key}\n\nThis action cannot be undone.`,
                              )
                            ) {
                              void handleDeleteKey(apiKey._id);
                            }
                          }}
                          disabled={deletingId === apiKey._id}
                          className="font-medium text-destructive transition-colors hover:text-destructive/80 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {deletingId === apiKey._id ? 'Deleting...' : 'Delete'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="border-t border-border bg-muted/20 px-6 py-3">
            <p className="text-xs text-muted-foreground">
              Showing {apiKeys.length} {apiKeys.length === 1 ? 'key' : 'keys'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
