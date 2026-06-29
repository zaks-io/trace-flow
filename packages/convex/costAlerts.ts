import {
  query,
  mutation,
  internalQuery,
  internalMutation,
  type QueryCtx,
  type MutationCtx,
} from './_generated/server';
import { paginationOptsValidator } from 'convex/server';
import { v, ConvexError } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { requireAuthenticated } from './auth/auth';
import { getCurrentUser, requireEnabledUser } from './auth/users';
import { internal } from './_generated/api';
import {
  apiKeyValidator,
  costAlertChannelConfigValidator,
  costAlertChannelValidator,
  costAlertConditionValidator,
  costAlertScopeValidator,
  costAlertSeverityValidator,
  costAlertStateValidator,
  costAlertValidator,
  organizationValidator,
} from './validators';
import { normalizeWebhookHeaders, parseWebhookDeliveryUrl } from './costAlertWebhookSecurity';

const CONFIG_CHANGE_RECHECK_MS = 5 * 1000;
const MAX_SCOPE_VALUE_LENGTH = 200;

const costAlertSettingsValidator = v.object({
  rules: v.array(costAlertValidator),
  channels: v.array(costAlertChannelValidator),
  states: v.array(costAlertStateValidator),
  apiKeys: v.array(apiKeyValidator),
  isOwner: v.boolean(),
});

type OrgContext = QueryCtx | MutationCtx;
type CostAlert = Doc<'costAlerts'>;
type CostAlertScope = NonNullable<CostAlert['scope']>;

async function requireOrgMember(ctx: OrgContext) {
  const user = await requireEnabledUser(ctx);
  if (!user.orgId) {
    throw new ConvexError('Organization not found');
  }

  const org = await ctx.db.get(user.orgId);
  if (!org) {
    throw new ConvexError('Organization not found');
  }

  return { user, org };
}

async function requireOrgOwner(ctx: OrgContext) {
  const { user, org } = await requireOrgMember(ctx);
  if (!isOrgOwner(user._id, org.ownerId)) {
    throw new ConvexError('Only organization owners can manage cost alerts');
  }

  return { user, org };
}

export function isOrgOwner(userId: Id<'users'>, ownerId: Id<'users'>): boolean {
  return userId === ownerId;
}

function trimOptionalScopeValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_SCOPE_VALUE_LENGTH) {
    throw new ConvexError(
      `Scope filter values must be ${MAX_SCOPE_VALUE_LENGTH} characters or fewer`,
    );
  }
  return trimmed;
}

export function normalizeAlertScope(
  scope: CostAlert['scope'] | undefined,
): CostAlertScope | undefined {
  if (!scope) {
    return undefined;
  }

  const normalized = {
    provider: trimOptionalScopeValue(scope.provider),
    model: trimOptionalScopeValue(scope.model),
    baggageOperation: trimOptionalScopeValue(scope.baggageOperation),
    baggageUserId: trimOptionalScopeValue(scope.baggageUserId),
  };

  return Object.values(normalized).some(Boolean) ? normalized : undefined;
}

function normalizeApiKeyIds(apiKeyIds: Id<'apiKeys'>[] | undefined): Id<'apiKeys'>[] | undefined {
  return apiKeyIds && apiKeyIds.length > 0 ? apiKeyIds : undefined;
}

export function normalizeChannelConfig(
  config:
    | Doc<'costAlertChannels'>['config']
    | {
        type: 'email';
        recipients: string[];
      }
    | {
        type: 'webhook';
        url: string;
        secret?: string;
        headers?: { key: string; value: string }[];
      },
) {
  if (config.type === 'email') {
    const recipients = Array.from(
      new Set(
        config.recipients
          .map((recipient) => recipient.trim().toLowerCase())
          .filter((recipient) => recipient.length > 0),
      ),
    );

    if (recipients.length === 0) {
      throw new ConvexError('Email channels require at least one recipient');
    }

    const invalidEmail = recipients.find((r) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r));
    if (invalidEmail) {
      throw new ConvexError(`Invalid email address: ${invalidEmail}`);
    }

    return { type: 'email' as const, recipients };
  }

  const url = config.url.trim();
  try {
    parseWebhookDeliveryUrl(url);
  } catch (error) {
    throw new ConvexError(error instanceof Error ? error.message : 'Invalid webhook URL');
  }

  let headers: { key: string; value: string }[];
  try {
    headers = normalizeWebhookHeaders(config.headers);
  } catch (error) {
    throw new ConvexError(error instanceof Error ? error.message : 'Invalid webhook header');
  }

  const secretTrimmed = config.secret?.trim();
  const isPlaceholder = secretTrimmed === WEBHOOK_SECRET_PLACEHOLDER;

  return {
    type: 'webhook' as const,
    url,
    // Placeholder means "keep existing" — resolved in updateChannel
    secret: isPlaceholder
      ? WEBHOOK_SECRET_PLACEHOLDER
      : secretTrimmed && secretTrimmed.length > 0
        ? secretTrimmed
        : undefined,
    headers: headers.length > 0 ? headers : undefined,
  };
}

export function validateAlertCondition(condition: CostAlert['condition']) {
  switch (condition.type) {
    case 'absolute_spend_threshold':
    case 'projected_monthly_over':
      if (condition.thresholdUsd <= 0) {
        throw new ConvexError('Threshold must be greater than zero');
      }
      return;
    case 'hourly_spend_spike':
      if (condition.baselineHours < 4 || condition.baselineHours > 168) {
        throw new ConvexError('Spike baseline must be between 4 and 168 hours');
      }
      if (condition.multiplier <= 1) {
        throw new ConvexError('Spike multiplier must be greater than 1');
      }
      if (condition.minCurrentHourUsd < 0 || condition.minIncreaseUsd < 0) {
        throw new ConvexError('Spike minimums cannot be negative');
      }
      return;
  }
}

async function assertApiKeysBelongToOrg(
  ctx: OrgContext,
  orgId: Id<'organizations'>,
  apiKeyIds: Id<'apiKeys'>[] | undefined,
) {
  if (apiKeyIds === undefined || apiKeyIds.length === 0) {
    return;
  }

  for (const apiKeyId of apiKeyIds) {
    const apiKey = await ctx.db.get(apiKeyId);
    if (apiKey?.orgId !== orgId) {
      throw new ConvexError('Invalid API key selection');
    }
  }
}

async function assertChannelsBelongToOrg(
  ctx: OrgContext,
  orgId: Id<'organizations'>,
  channelIds: Id<'costAlertChannels'>[],
) {
  if (channelIds.length === 0) {
    throw new ConvexError('Select at least one channel');
  }

  for (const channelId of channelIds) {
    const channel = await ctx.db.get(channelId);
    if (channel?.orgId !== orgId) {
      throw new ConvexError('Invalid channel selection');
    }
  }
}

const WEBHOOK_SECRET_PLACEHOLDER = '••••••••';

function redactChannelConfig(channel: Doc<'costAlertChannels'>): Doc<'costAlertChannels'> {
  if (channel.config.type !== 'webhook' || !channel.config.secret) return channel;
  return {
    ...channel,
    config: { ...channel.config, secret: WEBHOOK_SECRET_PLACEHOLDER },
  };
}

async function getSettingsForOrg(ctx: QueryCtx, orgId: Id<'organizations'>, isOwner: boolean) {
  const [rules, channels, states, apiKeys] = await Promise.all([
    ctx.db
      .query('costAlerts')
      .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
      .collect(),
    ctx.db
      .query('costAlertChannels')
      .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
      .collect(),
    ctx.db
      .query('costAlertStates')
      .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
      .collect(),
    ctx.db
      .query('apiKeys')
      .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
      .collect(),
  ]);

  return {
    rules: rules.sort((a, b) => b.updatedAt - a.updatedAt),
    channels: channels.sort((a, b) => b.updatedAt - a.updatedAt).map(redactChannelConfig),
    states,
    apiKeys,
    isOwner,
  };
}

async function updateMonitorSchedule(
  ctx: MutationCtx,
  orgId: Id<'organizations'>,
  delayMs: number | null,
  metadata?: { lastEvaluatedAt?: number; lastError?: string | undefined },
) {
  const [existingMonitor, alerts] = await Promise.all([
    ctx.db
      .query('costAlertMonitors')
      .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
      .first(),
    ctx.db
      .query('costAlerts')
      .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
      .collect(),
  ]);

  const hasEnabledAlerts = alerts.some((alert) => alert.enabled);
  const shouldSchedule = hasEnabledAlerts && delayMs !== null;

  let schedulerId: Id<'_scheduled_functions'> | undefined;
  let nextEvaluationAt: number | undefined;

  // Schedule new function BEFORE cancelling old one so a failed runAfter
  // doesn't leave the monitor permanently dead.
  if (shouldSchedule) {
    schedulerId = await ctx.scheduler.runAfter(
      delayMs,
      internal.integrations.costAlerts.evaluateOrg,
      {
        orgId,
      },
    );
    nextEvaluationAt = Date.now() + delayMs;
  }

  if (existingMonitor?.schedulerId) {
    await ctx.scheduler.cancel(existingMonitor.schedulerId);
  }

  if (existingMonitor) {
    await ctx.db.patch(existingMonitor._id, {
      schedulerId,
      nextEvaluationAt,
      lastEvaluatedAt: metadata?.lastEvaluatedAt ?? existingMonitor.lastEvaluatedAt,
      lastError: metadata?.lastError,
    });
    return;
  }

  await ctx.db.insert('costAlertMonitors', {
    orgId,
    schedulerId,
    nextEvaluationAt,
    lastEvaluatedAt: metadata?.lastEvaluatedAt,
    lastError: metadata?.lastError,
  });
}

export const listForCurrentOrg = query({
  args: {},
  returns: costAlertSettingsValidator,
  handler: async (ctx) => {
    await requireAuthenticated(ctx);
    const user = await getCurrentUser(ctx);
    if (!user?.orgId) {
      return {
        rules: [],
        channels: [],
        states: [],
        apiKeys: [],
        isOwner: false,
      };
    }

    const org = await ctx.db.get(user.orgId);
    const isOwner = org?.ownerId === user._id;
    return getSettingsForOrg(ctx, user.orgId, isOwner);
  },
});

export const listDeliveries = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    await requireAuthenticated(ctx);
    const user = await getCurrentUser(ctx);
    if (!user?.orgId) {
      return { page: [], isDone: true, continueCursor: '' };
    }

    return ctx.db
      .query('costAlertDeliveries')
      .withIndex('by_org_id_attempted_at', (q) => q.eq('orgId', user.orgId!))
      .order('desc')
      .paginate(args.paginationOpts);
  },
});

export const createChannel = mutation({
  args: {
    name: v.string(),
    config: costAlertChannelConfigValidator,
  },
  returns: v.id('costAlertChannels'),
  handler: async (ctx, args) => {
    await requireAuthenticated(ctx);
    const { user, org } = await requireOrgOwner(ctx);
    const name = args.name.trim();
    if (name.length === 0) {
      throw new ConvexError('Channel name is required');
    }

    const now = Date.now();
    const channelId = await ctx.db.insert('costAlertChannels', {
      orgId: org._id,
      name,
      enabled: true,
      config: normalizeChannelConfig(args.config),
      createdByUserId: user._id,
      createdAt: now,
      updatedAt: now,
    });

    await updateMonitorSchedule(ctx, org._id, CONFIG_CHANGE_RECHECK_MS);
    return channelId;
  },
});

export const updateChannel = mutation({
  args: {
    id: v.id('costAlertChannels'),
    name: v.optional(v.string()),
    config: v.optional(costAlertChannelConfigValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAuthenticated(ctx);
    const { org } = await requireOrgOwner(ctx);
    const channel = await ctx.db.get(args.id);
    if (channel?.orgId !== org._id) {
      throw new ConvexError('Channel not found');
    }

    let nextConfig = args.config ? normalizeChannelConfig(args.config) : channel.config;

    // Resolve placeholder secret — keep existing value from DB
    if (
      nextConfig.type === 'webhook' &&
      nextConfig.secret === WEBHOOK_SECRET_PLACEHOLDER &&
      channel.config.type === 'webhook'
    ) {
      nextConfig = { ...nextConfig, secret: channel.config.secret };
    }

    await ctx.db.patch(args.id, {
      name: args.name?.trim() ?? channel.name,
      config: nextConfig,
      updatedAt: Date.now(),
    });

    await updateMonitorSchedule(ctx, org._id, CONFIG_CHANGE_RECHECK_MS);
    return null;
  },
});

export const toggleChannel = mutation({
  args: { id: v.id('costAlertChannels') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAuthenticated(ctx);
    const { org } = await requireOrgOwner(ctx);
    const channel = await ctx.db.get(args.id);
    if (channel?.orgId !== org._id) {
      throw new ConvexError('Channel not found');
    }

    await ctx.db.patch(args.id, {
      enabled: !channel.enabled,
      updatedAt: Date.now(),
    });

    await updateMonitorSchedule(ctx, org._id, CONFIG_CHANGE_RECHECK_MS);
    return null;
  },
});

export const removeChannel = mutation({
  args: { id: v.id('costAlertChannels') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAuthenticated(ctx);
    const { user, org } = await requireOrgOwner(ctx);
    const channel = await ctx.db.get(args.id);
    if (channel?.orgId !== org._id) {
      throw new ConvexError('Channel not found');
    }

    const alerts = await ctx.db
      .query('costAlerts')
      .withIndex('by_org_id', (q) => q.eq('orgId', org._id))
      .collect();

    await Promise.all(
      alerts
        .filter((alert) => alert.channelIds.includes(args.id))
        .map((alert) =>
          ctx.db.patch(alert._id, {
            channelIds: alert.channelIds.filter((channelId) => channelId !== args.id),
            updatedAt: Date.now(),
            updatedByUserId: user._id,
          }),
        ),
    );

    await ctx.db.delete(args.id);
    await updateMonitorSchedule(ctx, org._id, CONFIG_CHANGE_RECHECK_MS);
    return null;
  },
});

export const testChannel = mutation({
  args: { channelId: v.id('costAlertChannels') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAuthenticated(ctx);
    const { org } = await requireOrgOwner(ctx);
    const channel = await ctx.db.get(args.channelId);
    if (channel?.orgId !== org._id) {
      throw new ConvexError('Channel not found');
    }

    await ctx.scheduler.runAfter(0, internal.integrations.costAlerts.sendTestChannel, {
      orgId: org._id,
      channelId: args.channelId,
    });
    return null;
  },
});

export const createAlert = mutation({
  args: {
    name: v.string(),
    severity: costAlertSeverityValidator,
    apiKeyIds: v.optional(v.array(v.id('apiKeys'))),
    scope: v.optional(costAlertScopeValidator),
    channelIds: v.array(v.id('costAlertChannels')),
    cooldownMinutes: v.number(),
    notifyOnRecovery: v.boolean(),
    condition: costAlertConditionValidator,
  },
  returns: v.id('costAlerts'),
  handler: async (ctx, args) => {
    await requireAuthenticated(ctx);
    const { user, org } = await requireOrgOwner(ctx);
    validateAlertCondition(args.condition);
    await assertApiKeysBelongToOrg(ctx, org._id, args.apiKeyIds);
    await assertChannelsBelongToOrg(ctx, org._id, args.channelIds);

    const name = args.name.trim();
    if (name.length === 0) {
      throw new ConvexError('Alert name is required');
    }

    if (args.cooldownMinutes < 0) {
      throw new ConvexError('Cooldown must be zero or greater');
    }

    const now = Date.now();
    const alertId = await ctx.db.insert('costAlerts', {
      orgId: org._id,
      name,
      enabled: true,
      severity: args.severity,
      apiKeyIds: normalizeApiKeyIds(args.apiKeyIds),
      scope: normalizeAlertScope(args.scope),
      channelIds: args.channelIds,
      cooldownMinutes: args.cooldownMinutes,
      notifyOnRecovery: args.notifyOnRecovery,
      condition: args.condition,
      createdByUserId: user._id,
      updatedByUserId: user._id,
      createdAt: now,
      updatedAt: now,
    });

    await updateMonitorSchedule(ctx, org._id, CONFIG_CHANGE_RECHECK_MS);
    return alertId;
  },
});

export const updateAlert = mutation({
  args: {
    id: v.id('costAlerts'),
    name: v.optional(v.string()),
    severity: v.optional(costAlertSeverityValidator),
    apiKeyIds: v.optional(v.array(v.id('apiKeys'))),
    scope: v.optional(costAlertScopeValidator),
    channelIds: v.optional(v.array(v.id('costAlertChannels'))),
    cooldownMinutes: v.optional(v.number()),
    notifyOnRecovery: v.optional(v.boolean()),
    condition: v.optional(costAlertConditionValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAuthenticated(ctx);
    const { user, org } = await requireOrgOwner(ctx);
    const alert = await ctx.db.get(args.id);
    if (alert?.orgId !== org._id) {
      throw new ConvexError('Alert not found');
    }

    const nextCondition = args.condition ?? alert.condition;
    validateAlertCondition(nextCondition);
    const nextApiKeyIds =
      args.apiKeyIds === undefined ? alert.apiKeyIds : normalizeApiKeyIds(args.apiKeyIds);
    const nextScope = args.scope === undefined ? alert.scope : normalizeAlertScope(args.scope);
    const nextChannelIds = args.channelIds ?? alert.channelIds;
    await assertApiKeysBelongToOrg(ctx, org._id, nextApiKeyIds);
    await assertChannelsBelongToOrg(ctx, org._id, nextChannelIds);

    const nextCooldownMinutes = args.cooldownMinutes ?? alert.cooldownMinutes;
    if (nextCooldownMinutes < 0) {
      throw new ConvexError('Cooldown must be zero or greater');
    }

    await ctx.db.patch(args.id, {
      name: args.name?.trim() ?? alert.name,
      severity: args.severity ?? alert.severity,
      apiKeyIds: nextApiKeyIds,
      scope: nextScope,
      channelIds: nextChannelIds,
      cooldownMinutes: nextCooldownMinutes,
      notifyOnRecovery: args.notifyOnRecovery ?? alert.notifyOnRecovery,
      condition: nextCondition,
      updatedByUserId: user._id,
      updatedAt: Date.now(),
    });

    await updateMonitorSchedule(ctx, org._id, CONFIG_CHANGE_RECHECK_MS);
    return null;
  },
});

export const toggleAlert = mutation({
  args: { id: v.id('costAlerts') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAuthenticated(ctx);
    const { user, org } = await requireOrgOwner(ctx);
    const alert = await ctx.db.get(args.id);
    if (alert?.orgId !== org._id) {
      throw new ConvexError('Alert not found');
    }

    await ctx.db.patch(args.id, {
      enabled: !alert.enabled,
      updatedByUserId: user._id,
      updatedAt: Date.now(),
    });

    await updateMonitorSchedule(ctx, org._id, CONFIG_CHANGE_RECHECK_MS);
    return null;
  },
});

export const removeAlert = mutation({
  args: { id: v.id('costAlerts') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAuthenticated(ctx);
    const { org } = await requireOrgOwner(ctx);
    const alert = await ctx.db.get(args.id);
    if (alert?.orgId !== org._id) {
      throw new ConvexError('Alert not found');
    }

    const state = await ctx.db
      .query('costAlertStates')
      .withIndex('by_alert_id', (q) => q.eq('costAlertId', args.id))
      .first();

    if (state) await ctx.db.delete(state._id);
    await ctx.db.delete(args.id);

    await ctx.scheduler.runAfter(0, internal.costAlerts.cleanupDeliveries, {
      costAlertId: args.id,
    });

    await updateMonitorSchedule(ctx, org._id, CONFIG_CHANGE_RECHECK_MS);
    return null;
  },
});

const DELIVERY_CLEANUP_BATCH_SIZE = 200;

export const cleanupDeliveries = internalMutation({
  args: { costAlertId: v.id('costAlerts') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const batch = await ctx.db
      .query('costAlertDeliveries')
      .withIndex('by_alert_id', (q) => q.eq('costAlertId', args.costAlertId))
      .take(DELIVERY_CLEANUP_BATCH_SIZE);

    if (batch.length === 0) return null;

    await Promise.all(batch.map((d) => ctx.db.delete(d._id)));

    if (batch.length === DELIVERY_CLEANUP_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.costAlerts.cleanupDeliveries, {
        costAlertId: args.costAlertId,
      });
    }

    return null;
  },
});

export const getRuntimeContext = internalQuery({
  args: { orgId: v.id('organizations') },
  returns: v.object({
    org: v.union(organizationValidator, v.null()),
    alerts: v.array(costAlertValidator),
    channels: v.array(costAlertChannelValidator),
    states: v.array(costAlertStateValidator),
    apiKeys: v.array(apiKeyValidator),
  }),
  handler: async (ctx, args) => {
    const [org, alerts, channels, states, apiKeys] = await Promise.all([
      ctx.db.get(args.orgId),
      ctx.db
        .query('costAlerts')
        .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
        .collect(),
      ctx.db
        .query('costAlertChannels')
        .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
        .collect(),
      ctx.db
        .query('costAlertStates')
        .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
        .collect(),
      ctx.db
        .query('apiKeys')
        .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
        .collect(),
    ]);

    return { org, alerts, channels, states, apiKeys };
  },
});

export const recoverStaleMonitors = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const staleThreshold = now - 15 * 60 * 1000;

    // Only fetch monitors that are overdue (nextEvaluationAt < staleThreshold)
    const staleMonitors = await ctx.db
      .query('costAlertMonitors')
      .withIndex('by_next_evaluation', (q) => q.lt('nextEvaluationAt', staleThreshold))
      .take(50);

    for (const monitor of staleMonitors) {
      await updateMonitorSchedule(ctx, monitor.orgId, 0, {
        lastError: `Monitor recovered by cron at ${new Date(now).toISOString()}`,
      });
    }

    return null;
  },
});

export const syncMonitor = internalMutation({
  args: {
    orgId: v.id('organizations'),
    delayMs: v.union(v.number(), v.null()),
    lastEvaluatedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await updateMonitorSchedule(ctx, args.orgId, args.delayMs, {
      lastEvaluatedAt: args.lastEvaluatedAt,
      lastError: args.lastError,
    });
    return null;
  },
});

export const recordState = internalMutation({
  args: {
    orgId: v.id('organizations'),
    costAlertId: v.id('costAlerts'),
    active: v.boolean(),
    lastEvaluatedAt: v.number(),
    lastNotificationAt: v.optional(v.number()),
    lastTriggeredAt: v.optional(v.number()),
    lastRecoveredAt: v.optional(v.number()),
    lastMetricValue: v.optional(v.number()),
    lastMetricLabel: v.optional(v.string()),
    lastSummary: v.optional(v.string()),
    lastDeliveryError: v.optional(v.string()),
  },
  returns: v.id('costAlertStates'),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('costAlertStates')
      .withIndex('by_alert_id', (q) => q.eq('costAlertId', args.costAlertId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        active: args.active,
        lastEvaluatedAt: args.lastEvaluatedAt,
        lastNotificationAt: args.lastNotificationAt,
        lastTriggeredAt: args.lastTriggeredAt,
        lastRecoveredAt: args.lastRecoveredAt,
        lastMetricValue: args.lastMetricValue,
        lastMetricLabel: args.lastMetricLabel,
        lastSummary: args.lastSummary,
        lastDeliveryError: args.lastDeliveryError,
      });
      return existing._id;
    }

    return await ctx.db.insert('costAlertStates', args);
  },
});

export const recordDelivery = internalMutation({
  args: {
    orgId: v.id('organizations'),
    costAlertId: v.optional(v.id('costAlerts')),
    channelId: v.id('costAlertChannels'),
    eventType: v.union(v.literal('triggered'), v.literal('recovered'), v.literal('test')),
    status: v.union(v.literal('success'), v.literal('failed')),
    idempotencyKey: v.string(),
    payloadSummary: v.string(),
    attemptedAt: v.number(),
    deliveredAt: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  returns: v.id('costAlertDeliveries'),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('costAlertDeliveries')
      .withIndex('by_idempotency_key', (q) => q.eq('idempotencyKey', args.idempotencyKey))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        status: args.status,
        payloadSummary: args.payloadSummary,
        attemptedAt: args.attemptedAt,
        deliveredAt: args.deliveredAt,
        error: args.error,
      });
      return existing._id;
    }

    return await ctx.db.insert('costAlertDeliveries', args);
  },
});
