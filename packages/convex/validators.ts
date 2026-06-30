import { v } from 'convex/values';

export const userValidator = v.object({
  _id: v.id('users'),
  _creationTime: v.number(),
  tokenIdentifier: v.string(),
  email: v.string(),
  name: v.optional(v.string()),
  picture: v.optional(v.string()),
  enabled: v.boolean(),
  orgId: v.optional(v.id('organizations')),
  inviteId: v.optional(v.id('invites')),
  isAdmin: v.optional(v.boolean()),
});

export const subscriptionValidator = v.object({
  _id: v.id('subscriptions'),
  _creationTime: v.number(),
  orgId: v.id('organizations'),
  tier: v.union(v.literal('hobby'), v.literal('pro')),
  status: v.union(
    v.literal('active'),
    v.literal('grace'),
    v.literal('suspended'),
    v.literal('canceled'),
  ),
  monthlyUnits: v.number(),
  addonUnits: v.number(),
  currentPeriodStart: v.number(),
  currentPeriodEnd: v.number(),
  currentPeriodOverageSpentCents: v.number(),
  addonPurchaseCount: v.number(),
  stripeCustomerId: v.optional(v.string()),
  stripeSubscriptionId: v.optional(v.string()),
  stripePlanItemId: v.optional(v.string()),
  cancelAtPeriodEnd: v.optional(v.boolean()),
  autoOverage: v.optional(v.boolean()),
  overageCapCents: v.optional(v.number()),
  gracePeriodSchedulerId: v.optional(v.id('_scheduled_functions')),
  deletionSchedulerId: v.optional(v.id('_scheduled_functions')),
  autoTopupPendingSince: v.optional(v.number()),
});

export const organizationValidator = v.object({
  _id: v.id('organizations'),
  _creationTime: v.number(),
  name: v.string(),
  ownerId: v.id('users'),
  stripeCustomerId: v.optional(v.string()),
  onboardingCompletedAt: v.optional(v.number()),
  deletedAt: v.optional(v.number()),
});

export const apiKeyValidator = v.object({
  _id: v.id('apiKeys'),
  _creationTime: v.number(),
  key: v.string(),
  expiresAt: v.number(),
  userId: v.optional(v.id('users')),
  orgId: v.optional(v.id('organizations')),
  name: v.optional(v.string()),
});

const collectorCredentialStatusValidator = v.union(v.literal('active'), v.literal('revoked'));

// Full record, including the secret hash — internal/admin paths only.
export const collectorCredentialValidator = v.object({
  _id: v.id('collectorCredentials'),
  _creationTime: v.number(),
  hashedSecret: v.string(),
  orgId: v.id('organizations'),
  userId: v.id('users'),
  collectorId: v.string(),
  name: v.optional(v.string()),
  platform: v.optional(v.string()),
  lastSeenAt: v.optional(v.number()),
  status: collectorCredentialStatusValidator,
  expiresAt: v.number(),
  revokedAt: v.optional(v.number()),
});

// Connected-Desktops view — the full record minus `hashedSecret`. Derived from
// the full validator so the public shape stays in sync and the secret hash can
// never leak to the client. This is what the user-facing `list` returns.
export const collectorCredentialPublicValidator = collectorCredentialValidator.omit('hashedSecret');

export const costAlertChannelConfigValidator = v.union(
  v.object({
    type: v.literal('email'),
    recipients: v.array(v.string()),
  }),
  v.object({
    type: v.literal('webhook'),
    url: v.string(),
    secret: v.optional(v.string()),
    headers: v.optional(
      v.array(
        v.object({
          key: v.string(),
          value: v.string(),
        }),
      ),
    ),
  }),
);

export const costAlertChannelValidator = v.object({
  _id: v.id('costAlertChannels'),
  _creationTime: v.number(),
  orgId: v.id('organizations'),
  name: v.string(),
  enabled: v.boolean(),
  config: costAlertChannelConfigValidator,
  createdByUserId: v.id('users'),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const costAlertScopeValidator = v.object({
  provider: v.optional(v.string()),
  model: v.optional(v.string()),
  baggageOperation: v.optional(v.string()),
  baggageUserId: v.optional(v.string()),
});

export const costAlertConditionValidator = v.union(
  v.object({
    type: v.literal('absolute_spend_threshold'),
    window: v.union(v.literal('last_hour'), v.literal('last_24_hours'), v.literal('month_to_date')),
    thresholdUsd: v.number(),
  }),
  v.object({
    type: v.literal('projected_monthly_over'),
    thresholdUsd: v.number(),
  }),
  v.object({
    type: v.literal('hourly_spend_spike'),
    baselineHours: v.number(),
    multiplier: v.number(),
    minCurrentHourUsd: v.number(),
    minIncreaseUsd: v.number(),
  }),
);

export const costAlertSeverityValidator = v.union(
  v.literal('info'),
  v.literal('warning'),
  v.literal('error'),
);

export const costAlertValidator = v.object({
  _id: v.id('costAlerts'),
  _creationTime: v.number(),
  orgId: v.id('organizations'),
  name: v.string(),
  enabled: v.boolean(),
  severity: costAlertSeverityValidator,
  apiKeyIds: v.optional(v.array(v.id('apiKeys'))),
  scope: v.optional(costAlertScopeValidator),
  channelIds: v.array(v.id('costAlertChannels')),
  cooldownMinutes: v.number(),
  notifyOnRecovery: v.boolean(),
  condition: costAlertConditionValidator,
  createdByUserId: v.id('users'),
  updatedByUserId: v.id('users'),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const costAlertStateValidator = v.object({
  _id: v.id('costAlertStates'),
  _creationTime: v.number(),
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
});

export const costAlertDeliveryValidator = v.object({
  _id: v.id('costAlertDeliveries'),
  _creationTime: v.number(),
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
});

export const costAlertMonitorValidator = v.object({
  _id: v.id('costAlertMonitors'),
  _creationTime: v.number(),
  orgId: v.id('organizations'),
  schedulerId: v.optional(v.id('_scheduled_functions')),
  nextEvaluationAt: v.optional(v.number()),
  lastEvaluatedAt: v.optional(v.number()),
  lastError: v.optional(v.string()),
});
