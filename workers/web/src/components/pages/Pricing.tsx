'use client';

import { type Preloaded, usePreloadedQuery, useMutation, useAction } from 'convex/react';
import { api } from '@convex/_generated/api';
import { useState } from 'react';
import type { Id, Doc } from '@convex/_generated/dataModel';

type ModelPricing = Doc<'modelPricing'>;
import { usePageHeader } from '@/components/PageHeaderContext';

interface PricingFormData {
  provider: string;
  model: string;
  promptCostPerMillion: number;
  completionCostPerMillion: number;
  cacheReadCostPerMillion?: number;
  cacheWriteCostPerMillion?: number;
  reasoningCostPerMillion?: number;
}

function formatMicrodollarsToDisplay(microdollars: number): string {
  // Convert from microdollars per million to dollars per million
  const dollarsPerMillion = microdollars / 1_000_000;
  return `$${dollarsPerMillion.toFixed(2)}`;
}

function displayToDollarsPerMillion(display: string): number {
  // Parse display value (e.g., "3.00") to microdollars per million
  const value = parseFloat(display);
  if (isNaN(value)) return 0;
  return Math.round(value * 1_000_000);
}

export default function Pricing({
  preloadedPricing,
}: {
  preloadedPricing: Preloaded<typeof api.modelPricing.list>;
}) {
  usePageHeader('Model Pricing');
  const pricing = usePreloadedQuery(preloadedPricing);
  const upsertPricing = useMutation(api.modelPricing.upsert);
  const deletePricing = useMutation(api.modelPricing.remove);
  const syncAllToKV = useAction(api.modelPricing.syncAllToKV);
  const importFromOpenRouter = useAction(api.modelPricing.importFromOpenRouter);

  const syncDefaults = useAction(api.modelPricing.syncDefaults);

  const [isImporting, setIsImporting] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isSyncingDefaults, setIsSyncingDefaults] = useState(false);
  const [deletingId, setDeletingId] = useState<Id<'modelPricing'> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<Id<'modelPricing'> | null>(null);
  const [formData, setFormData] = useState<PricingFormData>({
    provider: '',
    model: '',
    promptCostPerMillion: 0,
    completionCostPerMillion: 0,
  });
  const [filterProvider, setFilterProvider] = useState<string>('');

  const handleImportFromOpenRouter = async () => {
    setIsImporting(true);
    setError(null);
    setSuccess(null);

    try {
      const result = await importFromOpenRouter();
      setSuccess(`Imported ${result.imported} models from OpenRouter`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to import from OpenRouter');
    } finally {
      setIsImporting(false);
    }
  };

  const handleSyncAllToKV = async () => {
    setIsSyncing(true);
    setError(null);
    setSuccess(null);

    try {
      const result = await syncAllToKV();
      setSuccess(`Synced ${result.synced} pricing entries to KV`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sync to KV');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSyncDefaults = async () => {
    setIsSyncingDefaults(true);
    setError(null);
    setSuccess(null);

    try {
      const result = await syncDefaults();
      setSuccess(`Synced ${result.synced} default pricing entries`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sync defaults');
    } finally {
      setIsSyncingDefaults(false);
    }
  };

  const handleDelete = async (id: Id<'modelPricing'>) => {
    setDeletingId(id);
    setError(null);
    setSuccess(null);

    try {
      await deletePricing({ id });
      setSuccess('Pricing deleted successfully');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete pricing');
    } finally {
      setDeletingId(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    try {
      await upsertPricing({
        provider: formData.provider,
        model: formData.model,
        promptCostPerMillion: formData.promptCostPerMillion,
        completionCostPerMillion: formData.completionCostPerMillion,
        cacheReadCostPerMillion: formData.cacheReadCostPerMillion,
        cacheWriteCostPerMillion: formData.cacheWriteCostPerMillion,
        reasoningCostPerMillion: formData.reasoningCostPerMillion,
        source: 'manual',
      });
      setSuccess(editingId ? 'Pricing updated successfully' : 'Pricing created successfully');
      setShowForm(false);
      setEditingId(null);
      setFormData({
        provider: '',
        model: '',
        promptCostPerMillion: 0,
        completionCostPerMillion: 0,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save pricing');
    }
  };

  const handleEdit = (item: NonNullable<typeof pricing>[0]) => {
    setEditingId(item._id);
    setFormData({
      provider: item.provider,
      model: item.model,
      promptCostPerMillion: item.promptCostPerMillion,
      completionCostPerMillion: item.completionCostPerMillion,
      cacheReadCostPerMillion: item.cacheReadCostPerMillion,
      cacheWriteCostPerMillion: item.cacheWriteCostPerMillion,
      reasoningCostPerMillion: item.reasoningCostPerMillion,
    });
    setShowForm(true);
  };

  const filteredPricing = pricing?.filter(
    (p: ModelPricing) => !filterProvider || p.provider === filterProvider,
  );

  const uniqueProviders = [
    ...new Set(pricing?.map((p: ModelPricing) => p.provider) ?? []),
  ].sort() as string[];

  return (
    <div className="animate-fade-in">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">Manage model pricing for cost calculation</p>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => void handleSyncDefaults()}
            disabled={isSyncingDefaults}
            className="inline-flex items-center rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground shadow-sm transition-all hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSyncingDefaults ? (
              <>
                <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-foreground border-t-transparent" />
                Syncing...
              </>
            ) : (
              'Sync Defaults'
            )}
          </button>
          <button
            onClick={() => void handleImportFromOpenRouter()}
            disabled={isImporting}
            className="inline-flex items-center rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground shadow-sm transition-all hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isImporting ? (
              <>
                <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-foreground border-t-transparent" />
                Importing...
              </>
            ) : (
              'Import from OpenRouter'
            )}
          </button>
          <button
            onClick={() => void handleSyncAllToKV()}
            disabled={isSyncing}
            className="inline-flex items-center rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground shadow-sm transition-all hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSyncing ? (
              <>
                <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-foreground border-t-transparent" />
                Syncing...
              </>
            ) : (
              'Sync All to KV'
            )}
          </button>
          <button
            onClick={() => {
              setShowForm(true);
              setEditingId(null);
              setFormData({
                provider: '',
                model: '',
                promptCostPerMillion: 0,
                completionCostPerMillion: 0,
              });
            }}
            className="inline-flex items-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-all hover:bg-primary/90 hover:shadow-md hover:shadow-primary/20 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background"
          >
            Add Pricing
          </button>
        </div>
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

      {showForm && (
        <div className="mb-6 rounded-xl border border-border bg-card p-6">
          <h3 className="mb-4 text-lg font-medium">
            {editingId ? 'Edit Pricing' : 'Add New Pricing'}
          </h3>
          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium text-foreground">Provider</label>
                <input
                  type="text"
                  value={formData.provider}
                  onChange={(e) => setFormData({ ...formData, provider: e.target.value })}
                  placeholder="e.g., openai, anthropic"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  required
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-foreground">Model</label>
                <input
                  type="text"
                  value={formData.model}
                  onChange={(e) => setFormData({ ...formData, model: e.target.value })}
                  placeholder="e.g., gpt-4-turbo, claude-3-5-sonnet"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  required
                />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium text-foreground">
                  Input Cost ($/M tokens)
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={(formData.promptCostPerMillion / 1_000_000).toFixed(2)}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      promptCostPerMillion: displayToDollarsPerMillion(e.target.value),
                    })
                  }
                  placeholder="e.g., 3.00"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  required
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-foreground">
                  Output Cost ($/M tokens)
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={(formData.completionCostPerMillion / 1_000_000).toFixed(2)}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      completionCostPerMillion: displayToDollarsPerMillion(e.target.value),
                    })
                  }
                  placeholder="e.g., 15.00"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  required
                />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-foreground">
                  Cache Read Cost ($/M)
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={
                    formData.cacheReadCostPerMillion
                      ? (formData.cacheReadCostPerMillion / 1_000_000).toFixed(2)
                      : ''
                  }
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      cacheReadCostPerMillion: e.target.value
                        ? displayToDollarsPerMillion(e.target.value)
                        : undefined,
                    })
                  }
                  placeholder="Optional"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-foreground">
                  Cache Write Cost ($/M)
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={
                    formData.cacheWriteCostPerMillion
                      ? (formData.cacheWriteCostPerMillion / 1_000_000).toFixed(2)
                      : ''
                  }
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      cacheWriteCostPerMillion: e.target.value
                        ? displayToDollarsPerMillion(e.target.value)
                        : undefined,
                    })
                  }
                  placeholder="Optional"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-foreground">
                  Reasoning Cost ($/M)
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={
                    formData.reasoningCostPerMillion
                      ? (formData.reasoningCostPerMillion / 1_000_000).toFixed(2)
                      : ''
                  }
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      reasoningCostPerMillion: e.target.value
                        ? displayToDollarsPerMillion(e.target.value)
                        : undefined,
                    })
                  }
                  placeholder="Optional"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowForm(false);
                  setEditingId(null);
                }}
                className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition-all hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:bg-primary/90"
              >
                {editingId ? 'Update' : 'Create'}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="mb-4">
        <select
          value={filterProvider}
          onChange={(e) => setFilterProvider(e.target.value)}
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        >
          <option value="">All Providers</option>
          {uniqueProviders.map((provider) => (
            <option key={provider} value={provider}>
              {provider}
            </option>
          ))}
        </select>
      </div>

      {filteredPricing?.length === 0 ? (
        <div className="card-elevated rounded-xl border border-border bg-card p-12 text-center">
          <p className="text-muted-foreground">No pricing data found</p>
          <p className="mt-1 text-sm text-muted-foreground/70">
            Import from OpenRouter or add pricing manually
          </p>
        </div>
      ) : (
        <div className="card-elevated overflow-hidden rounded-xl border border-border bg-card">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-border">
              <thead className="bg-muted/30">
                <tr>
                  <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Provider
                  </th>
                  <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Model
                  </th>
                  <th className="px-6 py-3.5 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Input Cost
                  </th>
                  <th className="px-6 py-3.5 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Output Cost
                  </th>
                  <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Source
                  </th>
                  <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Updated
                  </th>
                  <th className="px-6 py-3.5 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border bg-card">
                {filteredPricing?.map((item: ModelPricing) => (
                  <tr key={item._id} className="table-row-interactive">
                    <td className="whitespace-nowrap px-6 py-4 text-sm text-foreground">
                      {item.provider}
                    </td>
                    <td className="max-w-xs truncate px-6 py-4 text-sm">
                      <code className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-xs text-foreground">
                        {item.model}
                      </code>
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-right text-sm text-foreground">
                      {formatMicrodollarsToDisplay(item.promptCostPerMillion)}/M
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-right text-sm text-foreground">
                      {formatMicrodollarsToDisplay(item.completionCostPerMillion)}/M
                    </td>
                    <td className="whitespace-nowrap px-6 py-4">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          item.source === 'default'
                            ? 'bg-emerald-500/20 text-emerald-400'
                            : item.source === 'openrouter'
                              ? 'bg-blue-500/20 text-blue-400'
                              : 'bg-purple-500/20 text-purple-400'
                        }`}
                      >
                        {item.source}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-sm text-muted-foreground">
                      {new Date(item.updatedAt).toLocaleDateString()}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-right text-sm">
                      <button
                        onClick={() => handleEdit(item)}
                        className="mr-3 font-medium text-primary transition-colors hover:text-primary/80"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => {
                          if (
                            confirm(
                              `Delete pricing for ${item.provider}/${item.model}?\n\nThis action cannot be undone.`,
                            )
                          ) {
                            void handleDelete(item._id);
                          }
                        }}
                        disabled={deletingId === item._id}
                        className="font-medium text-destructive transition-colors hover:text-destructive/80 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {deletingId === item._id ? 'Deleting...' : 'Delete'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-border bg-muted/20 px-6 py-3">
            <p className="text-xs text-muted-foreground">
              Showing {filteredPricing?.length ?? 0} of {pricing?.length ?? 0} pricing entries
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
