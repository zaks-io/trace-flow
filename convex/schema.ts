import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  apiKeys: defineTable({
    key: v.string(),
    expiresAt: v.number(),
  }),
});
