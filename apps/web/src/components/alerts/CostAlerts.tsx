'use client';

import { type Preloaded, useMutation, usePaginatedQuery, usePreloadedQuery } from 'convex/react';
import { api } from '@trace-flow/convex/_generated/api';
import type { Id } from '@trace-flow/convex/_generated/dataModel';
import { useMemo, useState } from 'react';
import { PageToolbar } from '@/components/shared/PageToolbar';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CostAlertChannelDialog } from './CostAlertChannelDialog';
import { CostAlertRuleDialog } from './CostAlertRuleDialog';
import { buttonClass, secondaryButtonClass } from './costAlertDialogStyles';
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
import { COST_ALERT_SEVERITY_LABELS } from '@/types/cost-alerts';

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

      <CostAlertChannelDialog
        open={channelDialogOpen}
        onOpenChange={setChannelDialogOpen}
        editingChannelId={editingChannelId}
        channelForm={channelForm}
        setChannelForm={setChannelForm}
        error={error}
        submitting={submitting}
        onSubmit={submitChannel}
      />

      <CostAlertRuleDialog
        open={alertDialogOpen}
        onOpenChange={setAlertDialogOpen}
        editingAlertId={editingAlertId}
        alertForm={alertForm}
        setAlertForm={setAlertForm}
        apiKeys={settings.apiKeys}
        channels={settings.channels}
        error={error}
        submitting={submitting}
        onSubmit={submitAlert}
      />
    </div>
  );
}
