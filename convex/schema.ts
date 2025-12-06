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
});
