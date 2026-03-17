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
  autoTopupPendingSince: v.optional(v.number()),
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
