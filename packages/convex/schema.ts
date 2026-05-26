import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  users: defineTable({
    tokenIdentifier: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    picture: v.optional(v.string()),
    enabled: v.boolean(),
    orgId: v.optional(v.id('organizations')),
    inviteId: v.optional(v.id('invites')),
    isAdmin: v.optional(v.boolean()),
  })
    .index('by_token_identifier', ['tokenIdentifier'])
    .index('by_org_id', ['orgId']),

  organizations: defineTable({
    name: v.string(),
    ownerId: v.id('users'),
    stripeCustomerId: v.optional(v.string()),
    onboardingCompletedAt: v.optional(v.number()),
    deletedAt: v.optional(v.number()),
  })
    .index('by_owner_id', ['ownerId'])
    .index('by_stripe_customer_id', ['stripeCustomerId']),

  subscriptions: defineTable({
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
    // Stripe ownership (org-scoped, not set until checkout)
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    stripePlanItemId: v.optional(v.string()),
    cancelAtPeriodEnd: v.optional(v.boolean()),
    // Overage controls (opt-in)
    autoOverage: v.optional(v.boolean()),
    overageCapCents: v.optional(v.number()),
    // Grace period -> suspended scheduler (transient)
    gracePeriodSchedulerId: v.optional(v.id('_scheduled_functions')),
    // Scheduled org data deletion after cancellation (transient)
    deletionSchedulerId: v.optional(v.id('_scheduled_functions')),
    // Auto-topup dedup (transient)
    autoTopupPendingSince: v.optional(v.number()),
  })
    .index('by_org_id', ['orgId'])
    .index('by_stripe_subscription_id', ['stripeSubscriptionId'])
    .index('by_stripe_customer_id', ['stripeCustomerId']),

  usage: defineTable({
    orgId: v.id('organizations'),
    periodStart: v.number(),
    periodEnd: v.number(),
    subscriptionUnitsUsed: v.number(),
    addonUnitsUsed: v.number(),
  }).index('by_org_id_period', ['orgId', 'periodStart']),

  apiKeys: defineTable({
    key: v.string(),
    expiresAt: v.number(),
    userId: v.optional(v.id('users')),
    orgId: v.optional(v.id('organizations')),
    name: v.optional(v.string()),
  })
    .index('by_user_id', ['userId'])
    .index('by_org_id', ['orgId']),

  modelPricing: defineTable({
    provider: v.string(),
    model: v.string(),
    promptCostPerMillion: v.number(),
    completionCostPerMillion: v.number(),
    cacheReadCostPerMillion: v.optional(v.number()),
    cacheWriteCostPerMillion: v.optional(v.number()),
    cacheWrite1hCostPerMillion: v.optional(v.number()),
    reasoningCostPerMillion: v.optional(v.number()),
    // Context-tier override (e.g. gpt-5.5 prices ~2x above its 272k-token tier). Defined inline
    // rather than imported to keep schema.ts free of any billing-module import cycle.
    contextTier: v.optional(
      v.object({
        thresholdTokens: v.number(),
        promptCostPerMillion: v.number(),
        completionCostPerMillion: v.number(),
        cacheReadCostPerMillion: v.optional(v.number()),
        cacheWriteCostPerMillion: v.optional(v.number()),
        cacheWrite1hCostPerMillion: v.optional(v.number()),
        reasoningCostPerMillion: v.optional(v.number()),
      }),
    ),
    source: v.union(
      v.literal('manual'),
      v.literal('openrouter'),
      v.literal('default'),
      v.literal('models.dev'),
    ),
    updatedAt: v.number(),
  })
    .index('by_provider', ['provider'])
    .index('by_provider_model', ['provider', 'model']),

  alerts: defineTable({
    name: v.string(),
    field: v.string(),
    operator: v.string(),
    value: v.union(v.number(), v.string(), v.boolean()),
    severity: v.string(),
    enabled: v.boolean(),
    userId: v.id('users'),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_user_id', ['userId']),

  costAlertChannels: defineTable({
    orgId: v.id('organizations'),
    name: v.string(),
    enabled: v.boolean(),
    config: v.union(
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
    ),
    createdByUserId: v.id('users'),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_org_id', ['orgId']),

  costAlerts: defineTable({
    orgId: v.id('organizations'),
    name: v.string(),
    enabled: v.boolean(),
    severity: v.union(v.literal('info'), v.literal('warning'), v.literal('error')),
    apiKeyIds: v.optional(v.array(v.id('apiKeys'))),
    channelIds: v.array(v.id('costAlertChannels')),
    cooldownMinutes: v.number(),
    notifyOnRecovery: v.boolean(),
    condition: v.union(
      v.object({
        type: v.literal('absolute_spend_threshold'),
        window: v.union(
          v.literal('last_hour'),
          v.literal('last_24_hours'),
          v.literal('month_to_date'),
        ),
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
    ),
    createdByUserId: v.id('users'),
    updatedByUserId: v.id('users'),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_org_id', ['orgId']),

  costAlertStates: defineTable({
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
  })
    .index('by_org_id', ['orgId'])
    .index('by_alert_id', ['costAlertId']),

  costAlertDeliveries: defineTable({
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
  })
    .index('by_org_id', ['orgId'])
    .index('by_org_id_attempted_at', ['orgId', 'attemptedAt'])
    .index('by_alert_id', ['costAlertId'])
    .index('by_channel_id', ['channelId'])
    .index('by_idempotency_key', ['idempotencyKey']),

  costAlertMonitors: defineTable({
    orgId: v.id('organizations'),
    schedulerId: v.optional(v.id('_scheduled_functions')),
    nextEvaluationAt: v.optional(v.number()),
    lastEvaluatedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
  })
    .index('by_org_id', ['orgId'])
    .index('by_next_evaluation', ['nextEvaluationAt']),

  mcpSessions: defineTable({
    sessionId: v.string(),
    userId: v.id('users'),
    protocolVersion: v.string(),
    state: v.union(v.literal('initializing'), v.literal('ready'), v.literal('shutdown')),
    expiresAt: v.number(),
  })
    .index('by_session_id', ['sessionId'])
    .index('by_user_id', ['userId']),

  mcpRefreshTokens: defineTable({
    tokenId: v.optional(v.string()),
    hashedTokenId: v.string(),
    userId: v.id('users'),
    auth0RefreshToken: v.string(),
    expiresAt: v.number(),
  })
    .index('by_token_id', ['hashedTokenId'])
    .index('by_user_id', ['userId']),

  mcpClients: defineTable({
    clientId: v.string(),
    redirectUris: v.array(v.string()),
    clientName: v.optional(v.string()),
  }).index('by_client_id', ['clientId']),

  mcpAuthCodes: defineTable({
    code: v.string(),
    userId: v.id('users'),
    clientId: v.optional(v.string()),
    redirectUri: v.string(),
    codeChallenge: v.optional(v.string()),
    codeChallengeMethod: v.optional(v.string()),
    auth0RefreshToken: v.string(),
    expiresAt: v.number(),
    used: v.boolean(),
  }).index('by_code', ['code']),

  invites: defineTable({
    email: v.string(),
    invitedBy: v.id('users'),
    orgId: v.optional(v.id('organizations')),
    status: v.union(v.literal('pending'), v.literal('accepted'), v.literal('expired')),
    token: v.string(),
    acceptedAt: v.optional(v.number()),
    expiresAt: v.number(),
  })
    .index('by_email', ['email'])
    .index('by_token', ['token'])
    .index('by_status', ['status'])
    .index('by_org_id_status', ['orgId', 'status']),

  organizationMembers: defineTable({
    orgId: v.id('organizations'),
    userId: v.id('users'),
    role: v.union(v.literal('owner'), v.literal('member')),
    status: v.union(v.literal('active'), v.literal('removed')),
    invitedAt: v.optional(v.number()),
    joinedAt: v.optional(v.number()),
    removedAt: v.optional(v.number()),
  })
    .index('by_org_id', ['orgId'])
    .index('by_user_id', ['userId'])
    .index('by_org_id_status', ['orgId', 'status']),

  addonPurchases: defineTable({
    orgId: v.id('organizations'),
    triggeredByUserId: v.optional(v.id('users')),
    units: v.number(),
    amountCents: v.number(),
    stripePaymentIntentId: v.string(),
    stripeInvoiceId: v.optional(v.string()),
    mode: v.union(v.literal('manual'), v.literal('auto')),
    periodStart: v.number(),
  })
    .index('by_org_id', ['orgId'])
    .index('by_payment_intent', ['stripePaymentIntentId']),

  stripeEvents: defineTable({
    eventId: v.string(),
    eventType: v.string(),
    stripeObjectId: v.optional(v.string()),
    status: v.union(v.literal('processing'), v.literal('processed'), v.literal('failed')),
    processingStartedAt: v.optional(v.number()),
    processedAt: v.optional(v.number()),
    error: v.optional(v.string()),
  })
    .index('by_event_id', ['eventId'])
    .index('by_status', ['status']),

  waitlist: defineTable({
    email: v.string(),
    source: v.optional(v.string()),
    confirmed: v.boolean(),
    confirmationToken: v.string(),
    notifiedAt: v.optional(v.number()),
  })
    .index('by_email', ['email'])
    .index('by_confirmation_token', ['confirmationToken']),

  feedback: defineTable({
    userId: v.id('users'),
    message: v.string(),
  }),

  // Hidden desktop Collector Credentials. Separate from user-facing `apiKeys`:
  // never shown on the API Keys page, never an `api_keys` JWT fixed_param, and
  // cannot call the Proxy. Only the SHA-256 hash of the secret is stored; the
  // plaintext is returned once at mint and lives in the desktop's Stronghold.
  collectorCredentials: defineTable({
    hashedSecret: v.string(),
    orgId: v.id('organizations'),
    userId: v.id('users'),
    collectorId: v.string(),
    name: v.optional(v.string()),
    platform: v.optional(v.string()),
    lastSeenAt: v.optional(v.number()),
    status: v.union(v.literal('active'), v.literal('revoked')),
    expiresAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index('by_org_id', ['orgId'])
    .index('by_user_id', ['userId'])
    .index('by_hashed_secret', ['hashedSecret']),

  // First-writer ownership claim for an Agent Session. The first accepted upload
  // of `OrgId + session_pk` claims it for that `UserId`; a later upload of the
  // same transcript under a different user is a permanent `session_owner_conflict`,
  // not an overwrite. Keeps `UserId` out of Tinybird row identity while pinning
  // ingestion ownership. `by_org_session` is the OCC first-writer guard.
  agentSessionOwners: defineTable({
    orgId: v.id('organizations'),
    sessionPk: v.string(),
    userId: v.id('users'),
    collectorId: v.string(),
    claimedAt: v.number(),
  }).index('by_org_session', ['orgId', 'sessionPk']),

  // Worker-side compatibility policy, owned in Convex (not env vars) so minimum
  // versions and the emergency denylist change without a Worker deploy. The
  // ingest Worker edge-caches the active row; an empty table makes it fail closed
  // with `policy_unavailable`. Latest row by `updatedAt` is active.
  collectorCompatibilityPolicy: defineTable({
    minDesktopVersion: v.string(),
    minParserVersion: v.string(),
    denylistedVersions: v.array(v.string()),
    updatedByUserId: v.optional(v.id('users')),
    updatedAt: v.number(),
  }).index('by_updated_at', ['updatedAt']),
});
