'use node';

import { internalAction, type ActionCtx } from '../_generated/server';
import { v } from 'convex/values';
import { render } from '@react-email/components';
import { Resend } from 'resend';
import { randomUUID } from 'node:crypto';
import { internal } from '../_generated/api';
import { CostAlertEmail } from '@trace-flow/emails';
import type { Id } from '../_generated/dataModel';
import { RETENTION_DAYS } from '@trace-flow/types';
import { fetchPipe as fetchPipeShared } from '@trace-flow/tinybird-client';
import { sendCostAlertWebhookNotification } from './costAlertWebhookDelivery';

const EMAIL_FROM = process.env.EMAIL_FROM ?? 'Trace Flow <noreply@updates.trace-flow.dev>';
const APP_URL = process.env.APP_URL ?? process.env.APP_BASE_URL ?? 'http://localhost:3000';
const TINYBIRD_API_URL = process.env.TINYBIRD_API_URL ?? 'https://api.us-west-2.aws.tinybird.co';
const TINYBIRD_ADMIN_TOKEN = process.env.TINYBIRD_ADMIN_TOKEN;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

interface UsageSummaryRow {
  total_cost_usd: number;
}

interface ForecastRow {
  projected_monthly_cost: number;
  month_to_date_cost: number;
  confidence_low: number;
  confidence_high: number;
  daily_average: number;
  insufficient_data: number;
}

interface HourlySpikeRow {
  current_hour_cost_usd: number;
  baseline_hourly_cost_usd: number;
  ratio_to_baseline: number;
  absolute_increase_usd: number;
  baseline_hours: number;
  insufficient_data: number;
}

interface ModelApprovalAnomalyRow {
  provider: string;
  model: string;
  request_count: number;
  token_count: number;
  total_cost_usd: number;
  unapproved_request_count: number;
  unpriced_request_count: number;
  first_seen_ns: number;
  last_seen_ns: number;
  sample_trace_id: string;
  sample_span_id: string;
}

interface CostAlertScope {
  provider?: string;
  model?: string;
  baggageOperation?: string;
  baggageUserId?: string;
}

interface ApprovedModel {
  provider: string;
  model: string;
  allowZeroCost?: boolean;
}

interface EvaluationResult {
  triggered: boolean;
  metricValue: number;
  metricLabel: string;
  summary: string;
  details?: unknown;
  /** When true, only notify on the first trigger — suppress re-notifications even after cooldown */
  suppressRenotify?: boolean;
}

type EventType = 'triggered' | 'recovered' | 'test';

async function fetchPipe<T>(
  pipe: string,
  params: Record<string, string | number | undefined>,
): Promise<T[]> {
  if (!TINYBIRD_ADMIN_TOKEN) {
    throw new Error('TINYBIRD_ADMIN_TOKEN environment variable is not set');
  }

  return fetchPipeShared<T>({
    baseUrl: TINYBIRD_API_URL,
    token: TINYBIRD_ADMIN_TOKEN,
    pipe,
    params,
  });
}

export function buildApiKeyParam(selectedKeys: string[]): string {
  return selectedKeys.length > 0 ? selectedKeys.join(',') : '__NO_KEYS__';
}

export function buildCostAlertPipeParams(
  base: {
    selectedKeys: string[];
    retentionDays: number;
    scope?: CostAlertScope;
  },
  extra: Record<string, string | number | undefined> = {},
): Record<string, string | number | undefined> {
  return {
    ...extra,
    api_keys: buildApiKeyParam(base.selectedKeys),
    retention_days: base.retentionDays,
    provider: base.scope?.provider,
    model: base.scope?.model,
    baggage_operation: base.scope?.baggageOperation,
    baggage_user_id: base.scope?.baggageUserId,
  };
}

function formatCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatScopeSuffix(scope: CostAlertScope | undefined): string {
  if (!scope) return '';

  const parts = [
    scope.provider ? `provider ${scope.provider}` : undefined,
    scope.model ? `model ${scope.model}` : undefined,
    scope.baggageOperation ? `operation ${scope.baggageOperation}` : undefined,
    scope.baggageUserId ? `user ${scope.baggageUserId}` : undefined,
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? ` Scope: ${parts.join(', ')}.` : '';
}

function nsFromMs(value: number): number {
  return value * 1_000_000;
}

function getAbsoluteWindow(condition: {
  type: 'absolute_spend_threshold';
  window: 'last_hour' | 'last_24_hours' | 'month_to_date';
  thresholdUsd: number;
}): { startMs: number; endMs: number; label: string } {
  const endMs = Date.now();
  switch (condition.window) {
    case 'last_hour':
      return { startMs: endMs - 60 * 60 * 1000, endMs, label: 'last hour' };
    case 'last_24_hours':
      return { startMs: endMs - 24 * 60 * 60 * 1000, endMs, label: 'last 24 hours' };
    case 'month_to_date': {
      const now = new Date(endMs);
      const startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
      return { startMs, endMs, label: 'month to date' };
    }
  }
}

function getAlertWindow(window: 'last_hour' | 'last_24_hours' | 'month_to_date') {
  return getAbsoluteWindow({
    type: 'absolute_spend_threshold',
    window,
    thresholdUsd: 1,
  });
}

function encodeProviderModelPairs(models: ApprovedModel[]): string {
  return models.map((entry) => `${entry.provider}|${entry.model}`).join(',');
}

export function buildModelApprovalPipeParams(
  base: {
    selectedKeys: string[];
    retentionDays: number;
    scope?: CostAlertScope;
  },
  condition: {
    window: 'last_hour' | 'last_24_hours' | 'month_to_date';
    approvedModels: ApprovedModel[];
  },
) {
  const window = getAlertWindow(condition.window);
  return buildCostAlertPipeParams(base, {
    start_time_ns: nsFromMs(window.startMs),
    end_time_ns: nsFromMs(window.endMs),
    approved_provider_models: encodeProviderModelPairs(condition.approvedModels),
    zero_cost_provider_models: encodeProviderModelPairs(
      condition.approvedModels.filter((entry) => entry.allowZeroCost),
    ),
  });
}

function formatTimestampNs(value: number): string {
  return new Date(Math.floor(value / 1_000_000)).toISOString();
}

function formatModelApprovalRow(row: ModelApprovalAnomalyRow): string {
  const reasons = [
    row.unapproved_request_count > 0 ? `${row.unapproved_request_count} unapproved` : undefined,
    row.unpriced_request_count > 0 ? `${row.unpriced_request_count} unpriced` : undefined,
  ].filter((reason): reason is string => Boolean(reason));

  return `${row.provider}/${row.model}: ${row.request_count} requests, ${row.token_count} tokens, first ${formatTimestampNs(row.first_seen_ns)}, last ${formatTimestampNs(row.last_seen_ns)}, sample ${row.sample_trace_id}/${row.sample_span_id}, ${reasons.join(' and ')}`;
}

export function summarizeModelApprovalAnomalies(
  rows: ModelApprovalAnomalyRow[],
  scope: CostAlertScope | undefined,
): EvaluationResult {
  if (rows.length === 0) {
    return {
      triggered: false,
      metricValue: 0,
      metricLabel: 'Model approval/pricing anomalies',
      summary: `No unapproved or unpriced model usage detected.${formatScopeSuffix(scope)}`,
      details: { rows: [] },
    };
  }

  const requestCount = rows.reduce((sum, row) => sum + Number(row.request_count), 0);
  const tokenCount = rows.reduce((sum, row) => sum + Number(row.token_count), 0);
  const unapprovedCount = rows.reduce((sum, row) => sum + Number(row.unapproved_request_count), 0);
  const unpricedCount = rows.reduce((sum, row) => sum + Number(row.unpriced_request_count), 0);
  const firstSeenNs = Math.min(...rows.map((row) => Number(row.first_seen_ns)));
  const lastSeenNs = Math.max(...rows.map((row) => Number(row.last_seen_ns)));

  return {
    triggered: true,
    metricValue: requestCount,
    metricLabel: 'Model approval/pricing anomalies',
    summary: `${rows.length} provider/model pairs breached approval or pricing rules: ${rows.map(formatModelApprovalRow).join('; ')}.${formatScopeSuffix(scope)}`,
    details: {
      requestCount,
      tokenCount,
      unapprovedRequestCount: unapprovedCount,
      unpricedRequestCount: unpricedCount,
      firstSeen: formatTimestampNs(firstSeenNs),
      lastSeen: formatTimestampNs(lastSeenNs),
      rows,
    },
  };
}

async function evaluateAlert(
  selectedKeys: string[],
  scope: CostAlertScope | undefined,
  retentionDays: number,
  condition:
    | {
        type: 'absolute_spend_threshold';
        window: 'last_hour' | 'last_24_hours' | 'month_to_date';
        thresholdUsd: number;
      }
    | {
        type: 'projected_monthly_over';
        thresholdUsd: number;
      }
    | {
        type: 'hourly_spend_spike';
        baselineHours: number;
        multiplier: number;
        minCurrentHourUsd: number;
        minIncreaseUsd: number;
      }
    | {
        type: 'model_approval_and_pricing';
        window: 'last_hour' | 'last_24_hours' | 'month_to_date';
        approvedModels: ApprovedModel[];
      },
): Promise<EvaluationResult> {
  if (condition.type === 'absolute_spend_threshold') {
    const window = getAbsoluteWindow(condition);
    const rows = await fetchPipe<UsageSummaryRow>(
      'llm_usage_summary',
      buildCostAlertPipeParams(
        { selectedKeys, scope, retentionDays },
        {
          start_time_ns: nsFromMs(window.startMs),
          end_time_ns: nsFromMs(window.endMs),
        },
      ),
    );
    const totalCost = Number(rows[0]?.total_cost_usd ?? 0);
    return {
      triggered: totalCost >= condition.thresholdUsd,
      metricValue: totalCost,
      metricLabel: `Spend in ${window.label}`,
      summary: `${formatCurrency(totalCost)} spent in the ${window.label} against a ${formatCurrency(condition.thresholdUsd)} threshold.${formatScopeSuffix(scope)}`,
      // MTD thresholds stay breached all month — only notify once
      suppressRenotify: condition.window === 'month_to_date',
    };
  }

  if (condition.type === 'projected_monthly_over') {
    const rows = await fetchPipe<ForecastRow>(
      'llm_cost_forecast',
      buildCostAlertPipeParams({ selectedKeys, scope, retentionDays }),
    );
    const forecast = rows[0];
    const projected = Number(forecast?.projected_monthly_cost ?? 0);
    const monthToDate = Number(forecast?.month_to_date_cost ?? 0);
    const insufficientData = Number(forecast?.insufficient_data ?? 1) === 1;

    if (insufficientData) {
      return {
        triggered: false,
        metricValue: projected,
        metricLabel: 'Projected monthly cost',
        summary: `Insufficient data — no spend recorded this month yet. Projection will activate once current-month usage appears.${formatScopeSuffix(scope)}`,
      };
    }

    return {
      triggered: projected >= condition.thresholdUsd,
      metricValue: projected,
      metricLabel: 'Projected monthly cost',
      summary: `Projected monthly cost is ${formatCurrency(projected)} with ${formatCurrency(monthToDate)} spent month-to-date, compared with a ${formatCurrency(condition.thresholdUsd)} budget.${formatScopeSuffix(scope)}`,
      suppressRenotify: true,
    };
  }

  if (condition.type === 'model_approval_and_pricing') {
    const rows = await fetchPipe<ModelApprovalAnomalyRow>(
      'llm_model_approval_anomalies',
      buildModelApprovalPipeParams({ selectedKeys, scope, retentionDays }, condition),
    );
    return summarizeModelApprovalAnomalies(rows, scope);
  }

  const rows = await fetchPipe<HourlySpikeRow>(
    'llm_cost_hourly_spike',
    buildCostAlertPipeParams(
      { selectedKeys, scope, retentionDays },
      {
        baseline_hours: condition.baselineHours,
        use_previous_hour: 1,
      },
    ),
  );
  const spike = rows[0];
  const hourCost = Number(spike?.current_hour_cost_usd ?? 0);
  const baseline = Number(spike?.baseline_hourly_cost_usd ?? 0);
  const increase = Number(spike?.absolute_increase_usd ?? 0);
  const ratio = Number(spike?.ratio_to_baseline ?? 0);
  const enoughData = Number(spike?.insufficient_data ?? 1) === 0;

  if (!enoughData) {
    return {
      triggered: false,
      metricValue: hourCost,
      metricLabel: 'Previous hour spend',
      summary: `Insufficient baseline data — need at least ${condition.baselineHours} hours of history before spike detection activates.${formatScopeSuffix(scope)}`,
    };
  }

  const triggered =
    hourCost >= condition.minCurrentHourUsd &&
    increase >= condition.minIncreaseUsd &&
    ratio >= condition.multiplier;

  return {
    triggered,
    metricValue: hourCost,
    metricLabel: 'Previous hour spend',
    summary: `Previous hour spend was ${formatCurrency(hourCost)} versus a ${formatCurrency(baseline)} trailing hourly baseline (${ratio.toFixed(2)}x, +${formatCurrency(increase)}).${formatScopeSuffix(scope)}`,
  };
}

export function shouldNotify(
  alert: {
    cooldownMinutes: number;
    notifyOnRecovery: boolean;
  },
  state:
    | {
        active: boolean;
        lastNotificationAt?: number;
        lastTriggeredAt?: number;
        lastRecoveredAt?: number;
      }
    | undefined,
  triggered: boolean,
  now: number,
  options?: { suppressRenotify?: boolean },
): {
  notify: boolean;
  eventType: EventType | null;
  active: boolean;
  lastNotificationAt?: number;
  lastTriggeredAt?: number;
  lastRecoveredAt?: number;
} {
  if (triggered) {
    const isNewTrigger = !state?.active;
    const cooldownMs = alert.cooldownMinutes * 60 * 1000;
    const cooldownExpired =
      !state?.lastNotificationAt ||
      cooldownMs === 0 ||
      now - state.lastNotificationAt >= cooldownMs;

    // For conditions that stay breached (MTD thresholds, projected cost),
    // only notify on the initial trigger — don't re-notify after cooldown
    const shouldFire = isNewTrigger || (cooldownExpired && !options?.suppressRenotify);

    return {
      notify: shouldFire,
      eventType: 'triggered',
      active: true,
      lastNotificationAt: shouldFire ? now : state?.lastNotificationAt,
      lastTriggeredAt: now,
      lastRecoveredAt: state?.lastRecoveredAt,
    };
  }

  if (state?.active) {
    return {
      notify: alert.notifyOnRecovery,
      eventType: alert.notifyOnRecovery ? 'recovered' : null,
      active: false,
      lastNotificationAt: alert.notifyOnRecovery ? now : state.lastNotificationAt,
      lastTriggeredAt: state.lastTriggeredAt,
      lastRecoveredAt: now,
    };
  }

  return {
    notify: false,
    eventType: null,
    active: false,
    lastNotificationAt: state?.lastNotificationAt,
    lastTriggeredAt: state?.lastTriggeredAt,
    lastRecoveredAt: state?.lastRecoveredAt,
  };
}

async function sendEmailNotification(
  recipients: string[],
  subject: string,
  summary: string,
  organizationName: string,
  dashboardUrl: string,
): Promise<void> {
  if (!RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY environment variable is not set');
  }

  const resend = new Resend(RESEND_API_KEY);
  const html = await render(
    CostAlertEmail({
      organizationName,
      subject,
      summary,
      dashboardUrl,
    }),
  );

  await resend.emails.send({
    from: EMAIL_FROM,
    to: recipients,
    subject,
    html,
  });
}

export function resolveScopedApiKeys(
  alert: {
    apiKeyIds?: string[];
  },
  apiKeys: { _id: string; key: string }[],
): string[] {
  if (alert.apiKeyIds?.length) {
    return alert.apiKeyIds
      .map((apiKeyId) => apiKeys.find((apiKey) => apiKey._id === apiKeyId)?.key)
      .filter((apiKey): apiKey is string => Boolean(apiKey));
  }

  return apiKeys.map((apiKey) => apiKey.key);
}

async function deliverEvent(args: {
  ctx: ActionCtx;
  traceId: string;
  orgId: Id<'organizations'>;
  orgName: string;
  alertId?: Id<'costAlerts'>;
  alertName: string;
  alertSeverity?: string;
  alertScope?: CostAlertScope;
  channel: {
    _id: Id<'costAlertChannels'>;
    name: string;
    config:
      | { type: 'email'; recipients: string[] }
      | {
          type: 'webhook';
          url: string;
          secret?: string;
          headers?: { key: string; value: string }[];
        };
  };
  eventType: EventType;
  metricLabel: string;
  summary: string;
  metricValue?: number;
  details?: unknown;
}) {
  const {
    ctx,
    traceId,
    orgId,
    orgName,
    alertId,
    alertName,
    channel,
    eventType,
    metricLabel,
    summary,
  } = args;
  const eventId = `${alertId ? String(alertId) : 'channel-test'}:${eventType}:${traceId}`;
  const idempotencyKey = `${eventId}:${channel._id}`;
  const payload = {
    eventId,
    eventType,
    occurredAt: new Date().toISOString(),
    organization: { id: orgId, name: orgName },
    alert: {
      id: alertId,
      name: alertName,
      severity: args.alertSeverity,
      scope: args.alertScope,
    },
    metric: {
      label: metricLabel,
      value: args.metricValue,
      summary,
      details: args.details,
    },
    channel: {
      id: channel._id,
      name: channel.name,
      type: channel.config.type,
    },
  };

  try {
    if (channel.config.type === 'email') {
      await sendEmailNotification(
        channel.config.recipients,
        `[Trace Flow] ${alertName} ${eventType === 'triggered' ? 'triggered' : eventType === 'recovered' ? 'recovered' : 'test'}`,
        summary,
        orgName,
        `${APP_URL}/app/alerts`,
      );
    } else {
      await sendCostAlertWebhookNotification(channel.config, payload, idempotencyKey);
    }

    await ctx.runMutation(internal.costAlerts.recordDelivery, {
      orgId,
      costAlertId: alertId,
      channelId: channel._id,
      eventType,
      status: 'success',
      idempotencyKey,
      payloadSummary: summary,
      attemptedAt: Date.now(),
      deliveredAt: Date.now(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown delivery failure';
    await ctx.runMutation(internal.costAlerts.recordDelivery, {
      orgId,
      costAlertId: alertId,
      channelId: channel._id,
      eventType,
      status: 'failed',
      idempotencyKey,
      payloadSummary: summary,
      attemptedAt: Date.now(),
      error: message,
    });
    throw error;
  }
}

export const evaluateOrg = internalAction({
  args: {
    orgId: v.id('organizations'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const runtime = await ctx.runQuery(internal.costAlerts.getRuntimeContext, {
      orgId: args.orgId,
    });
    const org = runtime.org;

    if (!org) {
      await ctx.runMutation(internal.costAlerts.syncMonitor, {
        orgId: args.orgId,
        delayMs: null,
        lastEvaluatedAt: Date.now(),
        lastError: 'Organization not found',
      });
      return null;
    }

    const channelMap = new Map(runtime.channels.map((channel) => [channel._id, channel]));
    const stateMap = new Map(runtime.states.map((state) => [state.costAlertId, state]));
    const enabledAlerts = runtime.alerts.filter((alert) => alert.enabled);
    const subscription = await ctx.runQuery(internal.billing.subscriptions.getByOrgId, {
      orgId: args.orgId,
    });
    const retentionDays = RETENTION_DAYS[subscription?.tier ?? 'hobby'];
    const now = Date.now();
    // Deterministic per evaluation run — same hour bucket produces the same
    // traceId so Convex action retries dedup via idempotencyKey.
    const hourBucket = Math.floor(now / (60 * 60 * 1000));
    const traceId = `${args.orgId}:${hourBucket}`;

    const orgErrors: string[] = [];

    for (const alert of enabledAlerts) {
      try {
        const scopedKeys = resolveScopedApiKeys(
          {
            apiKeyIds: alert.apiKeyIds?.map((apiKeyId) => String(apiKeyId)),
          },
          runtime.apiKeys.map((apiKey) => ({
            _id: String(apiKey._id),
            key: apiKey.key,
          })),
        );

        const evaluation = await evaluateAlert(
          scopedKeys,
          alert.scope,
          retentionDays,
          alert.condition,
        );
        const existingState = stateMap.get(alert._id);
        const transition = shouldNotify(alert, existingState, evaluation.triggered, now, {
          suppressRenotify: evaluation.suppressRenotify,
        });

        const deliveryErrors: string[] = [];
        if (transition.notify && transition.eventType) {
          const enabledChannels = alert.channelIds
            .map((channelId) => channelMap.get(channelId))
            .filter((channel): channel is (typeof runtime.channels)[number] =>
              Boolean(channel?.enabled),
            );

          if (enabledChannels.length === 0) {
            deliveryErrors.push('No enabled channels are assigned to this alert.');
          } else {
            for (const channel of enabledChannels) {
              try {
                await deliverEvent({
                  ctx,
                  traceId,
                  orgId: args.orgId,
                  orgName: org.name,
                  alertId: alert._id,
                  alertName: alert.name,
                  alertSeverity: alert.severity,
                  alertScope: alert.scope,
                  channel,
                  eventType: transition.eventType,
                  metricLabel: evaluation.metricLabel,
                  metricValue: evaluation.metricValue,
                  summary: evaluation.summary,
                  details: evaluation.details,
                });
              } catch (error) {
                deliveryErrors.push(
                  `${channel.name}: ${error instanceof Error ? error.message : 'Unknown delivery failure'}`,
                );
              }
            }
          }
        }

        await ctx.runMutation(internal.costAlerts.recordState, {
          orgId: args.orgId,
          costAlertId: alert._id,
          active: transition.active,
          lastEvaluatedAt: now,
          lastNotificationAt: transition.lastNotificationAt,
          lastTriggeredAt: transition.lastTriggeredAt,
          lastRecoveredAt: transition.lastRecoveredAt,
          lastMetricValue: evaluation.metricValue,
          lastMetricLabel: evaluation.metricLabel,
          lastSummary: evaluation.summary,
          lastDeliveryError: deliveryErrors.length > 0 ? deliveryErrors.join('; ') : undefined,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown evaluation failure';
        orgErrors.push(`Alert "${alert.name}": ${message}`);
        // Preserve existing timestamps so cooldown state isn't reset by an eval error
        const existing = stateMap.get(alert._id);
        await ctx.runMutation(internal.costAlerts.recordState, {
          orgId: args.orgId,
          costAlertId: alert._id,
          active: existing?.active ?? false,
          lastEvaluatedAt: now,
          lastNotificationAt: existing?.lastNotificationAt,
          lastTriggeredAt: existing?.lastTriggeredAt,
          lastRecoveredAt: existing?.lastRecoveredAt,
          lastMetricValue: existing?.lastMetricValue,
          lastMetricLabel: existing?.lastMetricLabel,
          lastSummary: `Evaluation failed: ${message}`,
          lastDeliveryError: message,
        });
      }
    }

    await ctx.runMutation(internal.costAlerts.syncMonitor, {
      orgId: args.orgId,
      delayMs: 60 * 60 * 1000,
      lastEvaluatedAt: now,
      lastError: orgErrors.length > 0 ? orgErrors.join('; ') : undefined,
    });
    return null;
  },
});

export const sendTestChannel = internalAction({
  args: {
    orgId: v.id('organizations'),
    channelId: v.id('costAlertChannels'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const runtime = await ctx.runQuery(internal.costAlerts.getRuntimeContext, {
      orgId: args.orgId,
    });
    const org = runtime.org;
    const channel = runtime.channels.find((entry) => entry._id === args.channelId);

    if (!org || !channel) {
      throw new Error('Channel not found');
    }

    await deliverEvent({
      ctx,
      traceId: `test:${args.channelId}:${Date.now()}:${randomUUID()}`,
      orgId: args.orgId,
      orgName: org.name,
      alertName: 'Cost alert channel test',
      channel,
      eventType: 'test',
      metricLabel: 'Channel test',
      summary: 'This is a test notification from Trace Flow cost alerting.',
      metricValue: 0,
    });

    return null;
  },
});
