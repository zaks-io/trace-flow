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
    source: v.union(v.literal('manual'), v.literal('openrouter'), v.literal('default')),
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
});
