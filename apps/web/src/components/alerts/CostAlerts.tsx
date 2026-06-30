'use client';

import { type Preloaded, useMutation, usePaginatedQuery, usePreloadedQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { useMemo, useState } from 'react';
import { PageToolbar } from '@/components/shared/PageToolbar';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DEFAULT_ALERT_FORM_DATA,
  DEFAULT_CHANNEL_FORM_DATA,
  alertFormFromRule,
  buildAlertInput,
  buildChannelConfigInput,
  channelFormFromChannel,
  formatChannelDestination,
  formatCondition,
  formatScope,
} from '@/lib/cost-alerts';
import type { AlertFormData, ChannelFormData } from '@/lib/cost-alerts';
import {
  COST_ALERT_CONDITION_LABELS,
  COST_ALERT_SEVERITY_LABELS,
  COST_ALERT_WINDOW_LABELS,
} from '@/types/cost-alerts';

const buttonClass =
  'inline-flex items-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-all hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50';

const secondaryButtonClass =
  'rounded-lg border border-border bg-transparent px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted';

function SelectField({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export default function CostAlerts({
  preloadedSettings,
}: {
  preloadedSettings: Preloaded<typeof api.costAlerts.listForCurrentOrg>;
}) {
  const settings = usePreloadedQuery(preloadedSettings);
  const createChannel = useMutation(api.costAlerts.createChannel);
  const updateChannel = useMutation(api.costAlerts.updateChannel);
  const toggleChannel = useMutation(api.costAlerts.toggleChannel);
  const removeChannel = useMutation(api.costAlerts.removeChannel);
  const testChannel = useMutation(api.costAlerts.testChannel);
  const createAlert = useMutation(api.costAlerts.createAlert);
  const updateAlert = useMutation(api.costAlerts.updateAlert);
  const toggleAlert = useMutation(api.costAlerts.toggleAlert);
  const removeAlert = useMutation(api.costAlerts.removeAlert);
  const {
    results: deliveries,
    status: deliveryStatus,
    loadMore,
  } = usePaginatedQuery(api.costAlerts.listDeliveries, {}, { initialNumItems: 25 });

  const [channelDialogOpen, setChannelDialogOpen] = useState(false);
  const [alertDialogOpen, setAlertDialogOpen] = useState(false);
  const [editingChannelId, setEditingChannelId] = useState<Id<'costAlertChannels'> | null>(null);
  const [editingAlertId, setEditingAlertId] = useState<Id<'costAlerts'> | null>(null);
  const [channelForm, setChannelForm] = useState<ChannelFormData>(DEFAULT_CHANNEL_FORM_DATA);
  const [alertForm, setAlertForm] = useState<AlertFormData>(DEFAULT_ALERT_FORM_DATA);
  const [submitting, setSubmitting] = useState(false);
  const [testingChannelId, setTestingChannelId] = useState<Id<'costAlertChannels'> | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const channelMap = useMemo(
    () => new Map(settings.channels.map((channel) => [String(channel._id), channel])),
    [settings.channels],
  );
  const stateMap = useMemo(
    () => new Map(settings.states.map((state) => [String(state.costAlertId), state])),
    [settings.states],
  );

  const clearMessages = () => {
    setError(null);
    setSuccess(null);
  };

  const withGuard = async (fn: () => Promise<void>) => {
    setSubmitting(true);
    clearMessages();
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setSubmitting(false);
    }
  };

  const openCreateChannel = () => {
    setEditingChannelId(null);
    setChannelForm(DEFAULT_CHANNEL_FORM_DATA);
    clearMessages();
    setChannelDialogOpen(true);
  };

  const openEditChannel = (channel: (typeof settings.channels)[number]) => {
    setEditingChannelId(channel._id);
    setChannelForm(channelFormFromChannel(channel));
    clearMessages();
    setChannelDialogOpen(true);
  };

  const openCreateAlert = () => {
    setEditingAlertId(null);
    setAlertForm(DEFAULT_ALERT_FORM_DATA);
    clearMessages();
    setAlertDialogOpen(true);
  };

  const openEditAlert = (rule: (typeof settings.rules)[number]) => {
    setEditingAlertId(rule._id);
    setAlertForm(alertFormFromRule(rule));
    clearMessages();
    setAlertDialogOpen(true);
  };

  const submitChannel = () =>
    void withGuard(async () => {
      const config = buildChannelConfigInput(channelForm);
      if (channelForm.name.trim().length === 0) {
        throw new Error('Channel name is required');
      }
      if (config.type === 'email' && config.recipients.length === 0) {
        throw new Error('Add at least one email recipient');
      }
      if (config.type === 'webhook' && config.url.length === 0) {
        throw new Error('Webhook URL is required');
      }

      if (editingChannelId) {
        await updateChannel({
          id: editingChannelId,
          name: channelForm.name,
          config,
        });
        setSuccess('Channel updated successfully');
      } else {
        await createChannel({
          name: channelForm.name,
          config,
        });
        setSuccess('Channel created successfully');
      }

      setChannelDialogOpen(false);
      setChannelForm(DEFAULT_CHANNEL_FORM_DATA);
    });

  const submitAlert = () =>
    void withGuard(async () => {
      const input = buildAlertInput(alertForm);
      if (input.name.length === 0) {
        throw new Error('Alert name is required');
      }
      if (input.channelIds.length === 0) {
        throw new Error('Select at least one delivery channel');
      }

      if (editingAlertId) {
        await updateAlert({
          id: editingAlertId,
          ...input,
        });
        setSuccess('Cost alert updated successfully');
      } else {
        await createAlert(input);
        setSuccess('Cost alert created successfully');
      }

      setAlertDialogOpen(false);
      setAlertForm(DEFAULT_ALERT_FORM_DATA);
    });

  const handleDeleteChannel = (channelId: Id<'costAlertChannels'>, name: string) => {
    setDeletingId(String(channelId));
    void withGuard(async () => {
      try {
        await removeChannel({ id: channelId });
        setSuccess(`Deleted channel "${name}"`);
      } finally {
        setDeletingId(null);
      }
    });
  };

  const handleDeleteAlert = (alertId: Id<'costAlerts'>, name: string) => {
    setDeletingId(String(alertId));
    void withGuard(async () => {
      try {
        await removeAlert({ id: alertId });
        setSuccess(`Deleted alert "${name}"`);
      } finally {
        setDeletingId(null);
      }
    });
  };

  const handleTestChannel = async (channelId: Id<'costAlertChannels'>) => {
    setTestingChannelId(channelId);
    clearMessages();
    try {
      await testChannel({ channelId });
      setSuccess('Test notification queued successfully');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to queue test notification');
    } finally {
      setTestingChannelId(null);
    }
  };

  const toggleListSelection = (list: string[], id: string) =>
    list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id];

  return (
    <div>
      <PageToolbar>
        <div>
          <p className="text-sm text-muted-foreground">
            Configure org-level spend thresholds, projected monthly cost alerts, and hourly spike
            detection.
          </p>
          {!settings.isOwner && (
            <p className="mt-1 text-xs text-muted-foreground">
              You can view cost alerts, but only the organization owner can change them.
            </p>
          )}
        </div>
        <div className="flex flex-1 justify-end gap-2">
          {settings.isOwner && (
            <>
              <button className={secondaryButtonClass} onClick={openCreateChannel}>
                New Channel
              </button>
              <button className={buttonClass} onClick={openCreateAlert}>
                New Cost Alert
              </button>
            </>
          )}
        </div>
      </PageToolbar>

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

      <Tabs defaultValue="rules">
        <TabsList>
          <TabsTrigger value="rules">Rules</TabsTrigger>
          <TabsTrigger value="channels">Channels</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="rules" className="mt-4">
          {settings.rules.length === 0 ? (
            <div className="card-elevated rounded-xl border border-border bg-card p-12 text-center">
              <p className="text-muted-foreground">No cost alerts configured</p>
              <p className="mt-1 text-sm text-muted-foreground/70">
                Create your first org-level alert to monitor spend and spikes.
              </p>
            </div>
          ) : (
            <div className="card-elevated overflow-hidden rounded-xl bg-card/40">
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-border">
                  <thead className="bg-muted/30">
                    <tr>
                      <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Alert
                      </th>
                      <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Condition
                      </th>
                      <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Scope
                      </th>
                      <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Last Evaluation
                      </th>
                      <th className="px-6 py-3.5 text-center text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Enabled
                      </th>
                      <th className="px-6 py-3.5 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border bg-card">
                    {settings.rules.map((rule) => {
                      const state = stateMap.get(String(rule._id));
                      return (
                        <tr key={rule._id} className="table-row-interactive">
                          <td className="px-6 py-4 text-sm">
                            <div className="font-medium text-foreground">{rule.name}</div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {COST_ALERT_SEVERITY_LABELS[rule.severity]} · {rule.channelIds.length}{' '}
                              channel{rule.channelIds.length === 1 ? '' : 's'}
                            </div>
                          </td>
                          <td className="px-6 py-4 text-sm text-foreground">
                            <div>{formatCondition(rule.condition)}</div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              Cooldown {rule.cooldownMinutes}m
                            </div>
                          </td>
                          <td className="px-6 py-4 text-sm text-foreground">
                            {formatScope(rule, settings.apiKeys)}
                          </td>
                          <td className="px-6 py-4 text-sm text-foreground">
                            {state ? (
                              <>
                                <div
                                  className={state.active ? 'text-amber-400' : 'text-foreground'}
                                >
                                  {state.lastSummary ?? 'No summary yet'}
                                </div>
                                <div className="mt-1 text-xs text-muted-foreground">
                                  {new Date(state.lastEvaluatedAt).toLocaleString()}
                                </div>
                              </>
                            ) : (
                              <span className="text-muted-foreground">Not evaluated yet</span>
                            )}
                          </td>
                          <td className="px-6 py-4 text-center">
                            <Switch
                              checked={rule.enabled}
                              disabled={!settings.isOwner}
                              onCheckedChange={() =>
                                void toggleAlert({ id: rule._id }).catch((err: unknown) =>
                                  setError(
                                    err instanceof Error ? err.message : 'Failed to toggle alert',
                                  ),
                                )
                              }
                            />
                          </td>
                          <td className="px-6 py-4 text-right text-sm">
                            {settings.isOwner && (
                              <>
                                <button
                                  onClick={() => openEditAlert(rule)}
                                  className="mr-3 font-medium text-primary transition-colors hover:text-primary/80"
                                >
                                  Edit
                                </button>
                                <button
                                  onClick={() => {
                                    if (
                                      confirm(
                                        `Delete the cost alert "${rule.name}"?\n\nThis action cannot be undone.`,
                                      )
                                    ) {
                                      handleDeleteAlert(rule._id, rule.name);
                                    }
                                  }}
                                  disabled={deletingId === String(rule._id)}
                                  className="font-medium text-destructive transition-colors hover:text-destructive/80 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  {deletingId === String(rule._id) ? 'Deleting...' : 'Delete'}
                                </button>
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="channels" className="mt-4">
          {settings.channels.length === 0 ? (
            <div className="card-elevated rounded-xl border border-border bg-card p-12 text-center">
              <p className="text-muted-foreground">No delivery channels configured</p>
              <p className="mt-1 text-sm text-muted-foreground/70">
                Add an email or webhook channel before creating spend alerts.
              </p>
            </div>
          ) : (
            <div className="card-elevated overflow-hidden rounded-xl bg-card/40">
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-border">
                  <thead className="bg-muted/30">
                    <tr>
                      <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Channel
                      </th>
                      <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Destination
                      </th>
                      <th className="px-6 py-3.5 text-center text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Enabled
                      </th>
                      <th className="px-6 py-3.5 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border bg-card">
                    {settings.channels.map((channel) => (
                      <tr key={channel._id} className="table-row-interactive">
                        <td className="px-6 py-4 text-sm">
                          <div className="font-medium text-foreground">{channel.name}</div>
                          <div className="mt-1 text-xs text-muted-foreground uppercase">
                            {channel.config.type}
                          </div>
                        </td>
                        <td className="px-6 py-4 text-sm text-foreground">
                          {formatChannelDestination(channel)}
                        </td>
                        <td className="px-6 py-4 text-center">
                          <Switch
                            checked={channel.enabled}
                            disabled={!settings.isOwner}
                            onCheckedChange={() =>
                              void toggleChannel({ id: channel._id }).catch((err: unknown) =>
                                setError(
                                  err instanceof Error ? err.message : 'Failed to toggle channel',
                                ),
                              )
                            }
                          />
                        </td>
                        <td className="px-6 py-4 text-right text-sm">
                          {settings.isOwner && (
                            <>
                              <button
                                onClick={() => void handleTestChannel(channel._id)}
                                disabled={testingChannelId === channel._id}
                                className="mr-3 font-medium text-primary transition-colors hover:text-primary/80 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {testingChannelId === channel._id ? 'Testing...' : 'Test'}
                              </button>
                              <button
                                onClick={() => openEditChannel(channel)}
                                className="mr-3 font-medium text-primary transition-colors hover:text-primary/80"
                              >
                                Edit
                              </button>
                              <button
                                onClick={() => {
                                  if (
                                    confirm(
                                      `Delete the channel "${channel.name}"?\n\nAny alerts using it will need another destination.`,
                                    )
                                  ) {
                                    handleDeleteChannel(channel._id, channel.name);
                                  }
                                }}
                                disabled={deletingId === String(channel._id)}
                                className="font-medium text-destructive transition-colors hover:text-destructive/80 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {deletingId === String(channel._id) ? 'Deleting...' : 'Delete'}
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="activity" className="mt-4">
          {deliveries.length === 0 ? (
            <div className="card-elevated rounded-xl border border-border bg-card p-12 text-center">
              <p className="text-muted-foreground">No recent activity yet</p>
              <p className="mt-1 text-sm text-muted-foreground/70">
                Delivery attempts and channel tests will appear here.
              </p>
            </div>
          ) : (
            <div className="card-elevated overflow-hidden rounded-xl bg-card/40">
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-border">
                  <thead className="bg-muted/30">
                    <tr>
                      <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Time
                      </th>
                      <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Event
                      </th>
                      <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Channel
                      </th>
                      <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Summary
                      </th>
                      <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border bg-card">
                    {deliveries.map((delivery) => (
                      <tr key={delivery._id} className="table-row-interactive">
                        <td className="px-6 py-4 text-sm text-foreground">
                          {new Date(delivery.attemptedAt).toLocaleString()}
                        </td>
                        <td className="px-6 py-4 text-sm text-foreground">{delivery.eventType}</td>
                        <td className="px-6 py-4 text-sm text-foreground">
                          {channelMap.get(String(delivery.channelId))?.name ?? 'Deleted channel'}
                        </td>
                        <td className="px-6 py-4 text-sm text-foreground">
                          <div>{delivery.payloadSummary}</div>
                          {delivery.error && (
                            <div className="mt-1 text-xs text-destructive">{delivery.error}</div>
                          )}
                        </td>
                        <td className="px-6 py-4 text-sm">
                          <span
                            className={
                              delivery.status === 'success'
                                ? 'text-emerald-400'
                                : 'text-destructive'
                            }
                          >
                            {delivery.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {deliveryStatus === 'CanLoadMore' && (
                <div className="border-t border-border bg-muted/20 px-6 py-3 text-center">
                  <button
                    onClick={() => loadMore(25)}
                    className="text-sm font-medium text-primary transition-colors hover:text-primary/80"
                  >
                    Load more
                  </button>
                </div>
              )}
              {deliveryStatus === 'LoadingMore' && (
                <div className="border-t border-border bg-muted/20 px-6 py-3 text-center">
                  <span className="text-sm text-muted-foreground">Loading...</span>
                </div>
              )}
            </div>
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={channelDialogOpen} onOpenChange={setChannelDialogOpen}>
        <DialogContent className="max-w-lg p-6">
          <DialogHeader>
            <DialogTitle>{editingChannelId ? 'Edit Channel' : 'Create Channel'}</DialogTitle>
            <DialogDescription>
              Configure email recipients or a webhook endpoint for cost alerts.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Name</label>
              <Input
                value={channelForm.name}
                onChange={(event) => setChannelForm({ ...channelForm, name: event.target.value })}
                placeholder="Ops email"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Type</label>
              <SelectField
                value={channelForm.type}
                onChange={(value) =>
                  setChannelForm({
                    ...channelForm,
                    type: value as ChannelFormData['type'],
                  })
                }
                options={[
                  { value: 'email', label: 'Email' },
                  { value: 'webhook', label: 'Webhook' },
                ]}
              />
            </div>

            {channelForm.type === 'email' ? (
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Recipients</label>
                <Input
                  value={channelForm.recipientsText}
                  onChange={(event) =>
                    setChannelForm({ ...channelForm, recipientsText: event.target.value })
                  }
                  placeholder="ops@example.com, finance@example.com"
                />
                <p className="text-xs text-muted-foreground">
                  Separate multiple email addresses with commas or new lines.
                </p>
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Webhook URL</label>
                  <Input
                    value={channelForm.webhookUrl}
                    onChange={(event) =>
                      setChannelForm({ ...channelForm, webhookUrl: event.target.value })
                    }
                    placeholder="https://example.com/webhooks/trace-flow"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Signing Secret</label>
                  <Input
                    value={channelForm.webhookSecret}
                    onChange={(event) =>
                      setChannelForm({ ...channelForm, webhookSecret: event.target.value })
                    }
                    placeholder="Optional secret for X-Trace-Flow-Signature"
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium text-foreground">Custom Headers</label>
                    <button
                      type="button"
                      className="text-sm text-primary"
                      onClick={() =>
                        setChannelForm({
                          ...channelForm,
                          webhookHeaders: [...channelForm.webhookHeaders, { key: '', value: '' }],
                        })
                      }
                    >
                      Add Header
                    </button>
                  </div>
                  {channelForm.webhookHeaders.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No custom headers configured.</p>
                  ) : (
                    <div className="space-y-2">
                      {channelForm.webhookHeaders.map((header, index) => (
                        <div key={`${index}-${header.key}`} className="grid grid-cols-2 gap-2">
                          <Input
                            value={header.key}
                            onChange={(event) =>
                              setChannelForm({
                                ...channelForm,
                                webhookHeaders: channelForm.webhookHeaders.map(
                                  (entry, entryIndex) =>
                                    entryIndex === index
                                      ? { ...entry, key: event.target.value }
                                      : entry,
                                ),
                              })
                            }
                            placeholder="Header name"
                          />
                          <div className="flex gap-2">
                            <Input
                              value={header.value}
                              onChange={(event) =>
                                setChannelForm({
                                  ...channelForm,
                                  webhookHeaders: channelForm.webhookHeaders.map(
                                    (entry, entryIndex) =>
                                      entryIndex === index
                                        ? { ...entry, value: event.target.value }
                                        : entry,
                                  ),
                                })
                              }
                              placeholder="Header value"
                            />
                            <button
                              type="button"
                              className="text-sm text-destructive"
                              onClick={() =>
                                setChannelForm({
                                  ...channelForm,
                                  webhookHeaders: channelForm.webhookHeaders.filter(
                                    (_entry, entryIndex) => entryIndex !== index,
                                  ),
                                })
                              }
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
          {error && (
            <div className="mt-4 rounded-lg border border-destructive/50 bg-destructive/10 p-3">
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}
          <DialogFooter className="mt-6">
            <button className={secondaryButtonClass} onClick={() => setChannelDialogOpen(false)}>
              Cancel
            </button>
            <button className={buttonClass} disabled={submitting} onClick={submitChannel}>
              {submitting ? 'Saving...' : editingChannelId ? 'Save Channel' : 'Create Channel'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={alertDialogOpen} onOpenChange={setAlertDialogOpen}>
        <DialogContent className="max-w-2xl p-6">
          <DialogHeader>
            <DialogTitle>{editingAlertId ? 'Edit Cost Alert' : 'Create Cost Alert'}</DialogTitle>
            <DialogDescription>
              Choose the cost condition, scope, delivery channels, and notification behavior.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Name</label>
              <Input
                value={alertForm.name}
                onChange={(event) => setAlertForm({ ...alertForm, name: event.target.value })}
                placeholder="Production monthly budget"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Severity</label>
              <SelectField
                value={alertForm.severity}
                onChange={(value) =>
                  setAlertForm({ ...alertForm, severity: value as AlertFormData['severity'] })
                }
                options={Object.entries(COST_ALERT_SEVERITY_LABELS).map(([value, label]) => ({
                  value,
                  label,
                }))}
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <label className="text-sm font-medium text-foreground">Condition</label>
              <SelectField
                value={alertForm.conditionType}
                onChange={(value) =>
                  setAlertForm({
                    ...alertForm,
                    conditionType: value as AlertFormData['conditionType'],
                  })
                }
                options={Object.entries(COST_ALERT_CONDITION_LABELS).map(([value, label]) => ({
                  value,
                  label,
                }))}
              />
            </div>

            {alertForm.conditionType === 'absolute_spend_threshold' && (
              <>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Time Window</label>
                  <SelectField
                    value={alertForm.window}
                    onChange={(value) =>
                      setAlertForm({ ...alertForm, window: value as AlertFormData['window'] })
                    }
                    options={Object.entries(COST_ALERT_WINDOW_LABELS).map(([value, label]) => ({
                      value,
                      label,
                    }))}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Threshold (USD)</label>
                  <Input
                    type="number"
                    value={alertForm.thresholdUsd}
                    onChange={(event) =>
                      setAlertForm({ ...alertForm, thresholdUsd: event.target.value })
                    }
                    placeholder="100"
                  />
                </div>
              </>
            )}

            {alertForm.conditionType === 'projected_monthly_over' && (
              <div className="space-y-2 md:col-span-2">
                <label className="text-sm font-medium text-foreground">Budget (USD)</label>
                <Input
                  type="number"
                  value={alertForm.thresholdUsd}
                  onChange={(event) =>
                    setAlertForm({ ...alertForm, thresholdUsd: event.target.value })
                  }
                  placeholder="1000"
                />
              </div>
            )}

            {alertForm.conditionType === 'hourly_spend_spike' && (
              <>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Baseline Hours</label>
                  <Input
                    type="number"
                    value={alertForm.baselineHours}
                    onChange={(event) =>
                      setAlertForm({ ...alertForm, baselineHours: event.target.value })
                    }
                    placeholder="24"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Spike Multiplier</label>
                  <Input
                    type="number"
                    value={alertForm.multiplier}
                    onChange={(event) =>
                      setAlertForm({ ...alertForm, multiplier: event.target.value })
                    }
                    placeholder="2"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">
                    Minimum Hourly Spend
                  </label>
                  <Input
                    type="number"
                    value={alertForm.minCurrentHourUsd}
                    onChange={(event) =>
                      setAlertForm({ ...alertForm, minCurrentHourUsd: event.target.value })
                    }
                    placeholder="10"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Minimum Increase</label>
                  <Input
                    type="number"
                    value={alertForm.minIncreaseUsd}
                    onChange={(event) =>
                      setAlertForm({ ...alertForm, minIncreaseUsd: event.target.value })
                    }
                    placeholder="5"
                  />
                </div>
              </>
            )}

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Cooldown (minutes)</label>
              <Input
                type="number"
                value={alertForm.cooldownMinutes}
                onChange={(event) =>
                  setAlertForm({ ...alertForm, cooldownMinutes: event.target.value })
                }
                placeholder="60"
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
              <div>
                <p className="text-sm font-medium text-foreground">Notify on recovery</p>
                <p className="text-xs text-muted-foreground">
                  Send a notification when the metric returns to normal.
                </p>
              </div>
              <Switch
                checked={alertForm.notifyOnRecovery}
                onCheckedChange={(checked) =>
                  setAlertForm({ ...alertForm, notifyOnRecovery: checked })
                }
              />
            </div>

            <div className="space-y-2 md:col-span-2">
              <label className="text-sm font-medium text-foreground">Dimension Scope</label>
              <div className="grid gap-3 rounded-lg border border-border p-3 md:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Provider</label>
                  <Input
                    value={alertForm.provider}
                    onChange={(event) =>
                      setAlertForm({ ...alertForm, provider: event.target.value })
                    }
                    maxLength={200}
                    placeholder="openai"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Model</label>
                  <Input
                    value={alertForm.model}
                    onChange={(event) => setAlertForm({ ...alertForm, model: event.target.value })}
                    maxLength={200}
                    placeholder="gpt-4o"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Operation</label>
                  <Input
                    value={alertForm.baggageOperation}
                    onChange={(event) =>
                      setAlertForm({ ...alertForm, baggageOperation: event.target.value })
                    }
                    maxLength={200}
                    placeholder="checkout"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">User ID</label>
                  <Input
                    value={alertForm.baggageUserId}
                    onChange={(event) =>
                      setAlertForm({ ...alertForm, baggageUserId: event.target.value })
                    }
                    maxLength={200}
                    placeholder="user_123"
                  />
                </div>
              </div>
            </div>

            <div className="space-y-2 md:col-span-2">
              <label className="text-sm font-medium text-foreground">API Key Scope</label>
              <div className="rounded-lg border border-border p-3">
                {settings.apiKeys.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No API keys available yet.</p>
                ) : (
                  <div className="space-y-2">
                    {settings.apiKeys.map((apiKey) => {
                      const checked = alertForm.apiKeyIds.includes(String(apiKey._id));
                      return (
                        <label key={apiKey._id} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setAlertForm({
                                ...alertForm,
                                apiKeyIds: toggleListSelection(
                                  alertForm.apiKeyIds,
                                  String(apiKey._id),
                                ),
                              })
                            }
                          />
                          <span>{apiKey.name ?? apiKey.key}</span>
                        </label>
                      );
                    })}
                    <p className="text-xs text-muted-foreground">
                      Leave all unchecked to alert across every API key in the organization.
                    </p>
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-2 md:col-span-2">
              <label className="text-sm font-medium text-foreground">Delivery Channels</label>
              <div className="rounded-lg border border-border p-3">
                {settings.channels.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Create a channel first so this alert has somewhere to deliver.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {settings.channels.map((channel) => {
                      const checked = alertForm.channelIds.includes(String(channel._id));
                      return (
                        <label key={channel._id} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setAlertForm({
                                ...alertForm,
                                channelIds: toggleListSelection(
                                  alertForm.channelIds,
                                  String(channel._id),
                                ),
                              })
                            }
                          />
                          <span>{channel.name}</span>
                          <span className="text-xs text-muted-foreground">
                            {formatChannelDestination(channel)}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
          {error && (
            <div className="mt-4 rounded-lg border border-destructive/50 bg-destructive/10 p-3">
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}
          <DialogFooter className="mt-6">
            <button className={secondaryButtonClass} onClick={() => setAlertDialogOpen(false)}>
              Cancel
            </button>
            <button className={buttonClass} disabled={submitting} onClick={submitAlert}>
              {submitting ? 'Saving...' : editingAlertId ? 'Save Alert' : 'Create Alert'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
