import { internalMutation } from './_generated/server';
import { sha256Hex } from '@trace-flow/utils';
import { scheduleKVSync } from './subscriptions';

// One-shot migration: backfill hashedTokenId for existing mcpRefreshTokens.
// Run: npx convex run migrations:backfillHashedTokenIds
// Delete after running.
export const backfillHashedTokenIds = internalMutation({
  args: {},
  handler: async (ctx) => {
    const tokens = await ctx.db.query('mcpRefreshTokens').collect();
    let patched = 0;
    for (const token of tokens) {
      // Skip tokens that already have hashedTokenId
      if (token.hashedTokenId) continue;
      // Old rows have tokenId but no hashedTokenId — hash and backfill
      const rawTokenId = (token as unknown as Record<string, unknown>).tokenId as
        | string
        | undefined;
      if (!rawTokenId) {
        // Token has neither field — delete as orphaned
        await ctx.db.delete(token._id);
        continue;
      }
      const hashedTokenId = await sha256Hex(rawTokenId);
      await ctx.db.patch(token._id, { hashedTokenId });
      patched++;
    }
    return { total: tokens.length, patched };
  },
});

// One-shot migration: backfill ALL tables to match the current schema.
// Run: bunx convex run migrations:backfillAll
// Delete this file after running.
export const backfillAll = internalMutation({
  args: {},
  handler: async (ctx) => {
    const results: Record<string, { total: number; patched: number }> = {};
    const now = Date.now();
    const periodEnd = now + 30 * 24 * 60 * 60 * 1000;

    // --- subscriptions: backfill missing required fields ---
    const subs = await ctx.db.query('subscriptions').collect();
    let subPatched = 0;
    for (const sub of subs) {
      const updates: Record<string, unknown> = {};
      if (sub.status === undefined) updates.status = 'active';
      if (sub.currentPeriodStart === undefined) updates.currentPeriodStart = now;
      if (sub.currentPeriodEnd === undefined) updates.currentPeriodEnd = periodEnd;
      if (sub.currentPeriodOverageSpentCents === undefined)
        updates.currentPeriodOverageSpentCents = 0;
      if (sub.addonPurchaseCount === undefined) updates.addonPurchaseCount = 0;
      if (Object.keys(updates).length > 0) {
        await ctx.db.patch(sub._id, updates);
        subPatched++;
      }
    }
    results.subscriptions = { total: subs.length, patched: subPatched };

    // --- users: ensure every user has an org ---
    const users = await ctx.db.query('users').collect();
    let userPatched = 0;
    for (const user of users) {
      if (!user.orgId) {
        const orgId = await ctx.db.insert('organizations', {
          name: `${user.name ? `${user.name}'s Org` : 'My Organization'}`,
          ownerId: user._id,
        });
        await ctx.db.patch(user._id, { orgId });
        await ctx.db.insert('organizationMembers', {
          orgId,
          userId: user._id,
          role: 'owner',
          status: 'active',
          joinedAt: now,
        });
        await ctx.db.insert('subscriptions', {
          orgId,
          tier: 'hobby',
          status: 'active',
          monthlyUnits: 25_000,
          addonUnits: 0,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          currentPeriodOverageSpentCents: 0,
          addonPurchaseCount: 0,
        });
        userPatched++;
      }
    }
    results.users = { total: users.length, patched: userPatched };

    // --- organizations: ensure each has a subscription + owner membership ---
    const orgs = await ctx.db.query('organizations').collect();
    let orgPatched = 0;
    for (const org of orgs) {
      const sub = await ctx.db
        .query('subscriptions')
        .withIndex('by_org_id', (q) => q.eq('orgId', org._id))
        .first();
      if (!sub) {
        await ctx.db.insert('subscriptions', {
          orgId: org._id,
          tier: 'hobby',
          status: 'active',
          monthlyUnits: 25_000,
          addonUnits: 0,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          currentPeriodOverageSpentCents: 0,
          addonPurchaseCount: 0,
        });
        orgPatched++;
      }

      const ownerMembership = await ctx.db
        .query('organizationMembers')
        .withIndex('by_user_id', (q) => q.eq('userId', org.ownerId))
        .filter((q) => q.eq(q.field('orgId'), org._id))
        .first();
      if (!ownerMembership) {
        await ctx.db.insert('organizationMembers', {
          orgId: org._id,
          userId: org.ownerId,
          role: 'owner',
          status: 'active',
          joinedAt: now,
        });
        orgPatched++;
      }
    }
    results.organizations = { total: orgs.length, patched: orgPatched };

    // --- organizationMembers: ensure role + status fields exist ---
    const members = await ctx.db.query('organizationMembers').collect();
    let memberPatched = 0;
    for (const member of members) {
      const updates: Record<string, unknown> = {};
      const raw = member as unknown as Record<string, unknown>;
      if (raw.role === undefined) updates.role = 'member';
      if (raw.status === undefined) updates.status = 'active';
      if (Object.keys(updates).length > 0) {
        await ctx.db.patch(member._id, updates);
        memberPatched++;
      }
    }
    results.organizationMembers = { total: members.length, patched: memberPatched };

    // --- KV sync: push all subscriptions to Cloudflare KV so proxy has correct billing status ---
    const allSubs = await ctx.db.query('subscriptions').collect();
    for (const sub of allSubs) {
      await scheduleKVSync(ctx, sub._id);
    }
    results.kvSyncs = { total: allSubs.length, patched: allSubs.length };

    return results;
  },
});
