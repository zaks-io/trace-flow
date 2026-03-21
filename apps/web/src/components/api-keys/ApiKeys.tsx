'use client';

import Link from 'next/link';
import { type Preloaded, usePreloadedQuery, useMutation, useAction, useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { useMemo, useState } from 'react';
import type { Id } from '@convex/_generated/dataModel';
import { PageToolbar } from '@/components/shared/PageToolbar';
import { ApiKeyQuickStart } from '@/components/onboarding/ApiKeyQuickStart';
import { SetupCallout } from '@/components/onboarding/SetupCallout';
import { useDefaultApiKey } from '@/hooks/useDefaultApiKey';

export default function ApiKeys({
  preloadedApiKeys,
}: {
  preloadedApiKeys: Preloaded<typeof api.apiKeys.list>;
}) {
  const sessionContext = useQuery(api.app.sessionContext);
  const apiKeys = usePreloadedQuery(preloadedApiKeys);
  // Sort inline — the hook's sortedApiKeys loses Id<"apiKeys"> because
  // Convex codegen types the list return as `any`, collapsing the generic.
  const sortedApiKeys = useMemo(
    () =>
      [...apiKeys].sort((a, b) => {
        const nameA = a.name ?? '';
        const nameB = b.name ?? '';
        if (nameA !== nameB) {
          if (!nameA) return 1;
          if (!nameB) return -1;
          return nameA.localeCompare(nameB);
        }
        return a._creationTime - b._creationTime;
      }),
    [apiKeys],
  );
  const { primaryApiKey, isCreatingDefaultKey, defaultKeyError } = useDefaultApiKey(
    apiKeys,
    Boolean(sessionContext?.user),
  );
  const createApiKey = useMutation(api.apiKeys.create);
  const updateApiKey = useMutation(api.apiKeys.update);
  const deleteApiKey = useMutation(api.apiKeys.remove);
  const syncToKV = useAction(api.apiKeys.syncToKV);

  const [isCreating, setIsCreating] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [editingKey, setEditingKey] = useState<{ id: Id<'apiKeys'>; name: string } | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [deletingId, setDeletingId] = useState<Id<'apiKeys'> | null>(null);
  const [syncingId, setSyncingId] = useState<Id<'apiKeys'> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const withGuard = async (setLoading: (v: boolean) => void, fn: () => Promise<void>) => {
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateKey = () =>
    void withGuard(setIsCreating, async () => {
      await createApiKey({
        expiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000,
        name: newKeyName.trim() || undefined,
      });
      setSuccess('API key created successfully');
      setShowCreateDialog(false);
      setNewKeyName('');
    });

  const handleDeleteKey = (id: Id<'apiKeys'>) => {
    setDeletingId(id);
    void withGuard(
      () => {},
      async () => {
        try {
          await deleteApiKey({ id });
          setSuccess('API key deleted successfully');
        } finally {
          setDeletingId(null);
        }
      },
    );
  };

  const handleSyncKey = (id: Id<'apiKeys'>) => {
    setSyncingId(id);
    void withGuard(
      () => {},
      async () => {
        try {
          const result = await syncToKV({ id });
          setSuccess(result.existed ? 'API key already exists in KV' : 'API key synced to KV');
        } finally {
          setSyncingId(null);
        }
      },
    );
  };

  const handleUpdateKey = () =>
    void withGuard(setIsUpdating, async () => {
      if (!editingKey) return;
      await updateApiKey({ id: editingKey.id, name: editingKey.name.trim() || undefined });
      setSuccess('API key updated successfully');
      setEditingKey(null);
    });

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
      <PageToolbar>
        <p className="text-sm text-muted-foreground">
          Manage your API keys for accessing the proxy service
        </p>
        <div className="flex-1" />
        <button
          onClick={() => setShowCreateDialog(true)}
          className="inline-flex items-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-all hover:bg-primary/90 hover:shadow-md hover:shadow-primary/20 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background"
        >
          Create API Key
        </button>
      </PageToolbar>

      {showCreateDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-lg">
            <h2 className="mb-4 text-lg font-semibold text-foreground">Create API Key</h2>
            <div className="mb-4">
              <label htmlFor="keyName" className="mb-1.5 block text-sm font-medium text-foreground">
                Name (optional)
              </label>
              <input
                id="keyName"
                type="text"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="e.g., Production, Development, My App"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                Give your key a name to help identify its purpose
              </p>
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => {
                  setShowCreateDialog(false);
                  setNewKeyName('');
                }}
                className="rounded-lg px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateKey}
                disabled={isCreating}
                className="inline-flex items-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-all hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isCreating ? (
                  <>
                    <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
                    Creating...
                  </>
                ) : (
                  'Create'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {editingKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-lg">
            <h2 className="mb-4 text-lg font-semibold text-foreground">Edit API Key</h2>
            <div className="mb-4">
              <label
                htmlFor="editKeyName"
                className="mb-1.5 block text-sm font-medium text-foreground"
              >
                Name
              </label>
              <input
                id="editKeyName"
                type="text"
                value={editingKey.name}
                onChange={(e) => setEditingKey({ ...editingKey, name: e.target.value })}
                placeholder="e.g., Production, Development, My App"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setEditingKey(null)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={handleUpdateKey}
                disabled={isUpdating}
                className="inline-flex items-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-all hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isUpdating ? (
                  <>
                    <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
                    Saving...
                  </>
                ) : (
                  'Save'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

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

      {primaryApiKey ? (
        <div className="mb-6">
          <ApiKeyQuickStart
            apiKey={primaryApiKey.key}
            title="Use this key in your app"
            description="This page is for long-term API key management, but you can also copy the current default key and env vars from here."
          />
        </div>
      ) : null}

      {isCreatingDefaultKey ? (
        <div className="mb-6 rounded-xl border border-border bg-card/60 p-4 text-sm text-muted-foreground">
          Generating your default API key...
        </div>
      ) : null}

      {defaultKeyError ? (
        <div className="mb-6 rounded-xl border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          {defaultKeyError}
        </div>
      ) : null}

      {sortedApiKeys.length === 0 ? (
        <SetupCallout
          title="No API keys yet"
          description="Trace Flow generates a default key automatically. If it does not show up here, return to getting started and finish the first-run setup."
          primaryHref="/app"
          primaryLabel="Return to getting started"
          secondaryHref="/docs/quick-start"
          secondaryLabel="Open quick start"
        />
      ) : (
        <div className="card-elevated overflow-hidden rounded-xl bg-card/40">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-border">
              <thead className="bg-muted/30">
                <tr>
                  <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Name
                  </th>
                  <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    API Key
                  </th>
                  <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Created
                  </th>
                  <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Expires
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
                {sortedApiKeys.map((apiKey) => {
                  const { formatted, isExpired } = formatExpiration(apiKey.expiresAt);
                  const expiringSoon = isExpiringSoon(apiKey.expiresAt);

                  return (
                    <tr key={apiKey._id} className="table-row-interactive">
                      <td className="whitespace-nowrap px-6 py-4 text-sm text-foreground">
                        {apiKey.name ?? <span className="text-muted-foreground">Unnamed</span>}
                      </td>
                      <td className="whitespace-nowrap px-6 py-4 text-sm">
                        <code className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-xs text-foreground">
                          {apiKey.key}
                        </code>
                      </td>
                      <td className="whitespace-nowrap px-6 py-4 text-sm text-foreground">
                        {new Date(apiKey._creationTime).toLocaleDateString()}
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
                          onClick={() => setEditingKey({ id: apiKey._id, name: apiKey.name ?? '' })}
                          className="mr-3 font-medium text-primary transition-colors hover:text-primary/80"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleSyncKey(apiKey._id)}
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
                              handleDeleteKey(apiKey._id);
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
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
              <p>
                Showing {sortedApiKeys.length} {sortedApiKeys.length === 1 ? 'key' : 'keys'}
              </p>
              <Link className="text-primary hover:underline" href="/app">
                Back to getting started
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
