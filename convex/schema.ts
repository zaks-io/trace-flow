import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  users: defineTable({
    tokenIdentifier: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    picture: v.optional(v.string()),
    enabled: v.boolean(),
  }).index('by_token_identifier', ['tokenIdentifier']),

  apiKeys: defineTable({
    key: v.string(),
    expiresAt: v.number(),
    userId: v.optional(v.id('users')),
  }).index('by_user_id', ['userId']),

  modelPricing: defineTable({
    provider: v.string(),
    model: v.string(),
    promptCostPerMillion: v.number(),
    completionCostPerMillion: v.number(),
    cacheReadCostPerMillion: v.optional(v.number()),
    cacheWriteCostPerMillion: v.optional(v.number()),
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
    tokenId: v.string(),
    userId: v.id('users'),
    auth0RefreshToken: v.string(),
    expiresAt: v.number(),
  })
    .index('by_token_id', ['tokenId'])
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
});
