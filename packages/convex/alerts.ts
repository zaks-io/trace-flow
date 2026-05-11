import { mutation, query } from './_generated/server';
import { v } from 'convex/values';
import { requireAuthenticated } from './auth/auth';
import { getCurrentUser, requireEnabledUser } from './auth/users';

const alertFieldValidator = v.union(
  v.literal('duration_ms'),
  v.literal('tokens_per_second'),
  v.literal('total_tokens'),
  v.literal('prompt_tokens'),
  v.literal('completion_tokens'),
  v.literal('ttft_ms'),
  v.literal('is_error'),
  v.literal('http_status_code'),
  v.literal('cost_total'),
);

const alertOperatorValidator = v.union(
  v.literal('gt'),
  v.literal('gte'),
  v.literal('lt'),
  v.literal('lte'),
  v.literal('eq'),
  v.literal('neq'),
);

const alertSeverityValidator = v.union(v.literal('info'), v.literal('warning'), v.literal('error'));

export const list = query({
  handler: async (ctx) => {
    await requireAuthenticated(ctx);
    const user = await getCurrentUser(ctx);

    if (!user) {
      return [];
    }

    return await ctx.db
      .query('alerts')
      .withIndex('by_user_id', (q) => q.eq('userId', user._id))
      .collect();
  },
});

export const listEnabled = query({
  handler: async (ctx) => {
    await requireAuthenticated(ctx);
    const user = await getCurrentUser(ctx);

    if (!user) {
      return [];
    }

    const alerts = await ctx.db
      .query('alerts')
      .withIndex('by_user_id', (q) => q.eq('userId', user._id))
      .collect();

    return alerts.filter((alert) => alert.enabled);
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    field: alertFieldValidator,
    operator: alertOperatorValidator,
    value: v.union(v.number(), v.string(), v.boolean()),
    severity: alertSeverityValidator,
  },
  handler: async (ctx, args) => {
    await requireAuthenticated(ctx);
    const user = await requireEnabledUser(ctx);

    const now = Date.now();
    return await ctx.db.insert('alerts', {
      name: args.name,
      field: args.field,
      operator: args.operator,
      value: args.value,
      severity: args.severity,
      enabled: true,
      userId: user._id,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  args: {
    id: v.id('alerts'),
    name: v.optional(v.string()),
    field: v.optional(alertFieldValidator),
    operator: v.optional(alertOperatorValidator),
    value: v.optional(v.union(v.number(), v.string(), v.boolean())),
    severity: v.optional(alertSeverityValidator),
  },
  handler: async (ctx, args) => {
    await requireAuthenticated(ctx);
    const user = await requireEnabledUser(ctx);

    const alert = await ctx.db.get(args.id);
    if (!alert) {
      throw new Error('Alert not found');
    }

    if (alert.userId !== user._id) {
      throw new Error('You do not have permission to update this alert');
    }

    const { id, ...updates } = args;
    const fieldsToUpdate: Record<string, unknown> = { updatedAt: Date.now() };

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        fieldsToUpdate[key] = value;
      }
    }

    await ctx.db.patch(id, fieldsToUpdate);
  },
});

export const toggle = mutation({
  args: { id: v.id('alerts') },
  handler: async (ctx, args) => {
    await requireAuthenticated(ctx);
    const user = await requireEnabledUser(ctx);

    const alert = await ctx.db.get(args.id);
    if (!alert) {
      throw new Error('Alert not found');
    }

    if (alert.userId !== user._id) {
      throw new Error('You do not have permission to toggle this alert');
    }

    await ctx.db.patch(args.id, {
      enabled: !alert.enabled,
      updatedAt: Date.now(),
    });
  },
});

export const remove = mutation({
  args: { id: v.id('alerts') },
  handler: async (ctx, args) => {
    await requireAuthenticated(ctx);
    const user = await requireEnabledUser(ctx);

    const alert = await ctx.db.get(args.id);
    if (!alert) {
      throw new Error('Alert not found');
    }

    if (alert.userId !== user._id) {
      throw new Error('You do not have permission to delete this alert');
    }

    await ctx.db.delete(args.id);
  },
});
