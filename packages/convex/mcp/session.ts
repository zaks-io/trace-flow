import { internalMutation, internalQuery } from '../_generated/server';
import { v } from 'convex/values';
import { SESSION_TTL_MS } from './protocol';
import { type Doc } from '../_generated/dataModel';
import { internal } from '../_generated/api';

export type McpSessionState = 'initializing' | 'ready' | 'shutdown';

const mcpSessionValidator = v.object({
  _id: v.id('mcpSessions'),
  _creationTime: v.number(),
  sessionId: v.string(),
  userId: v.id('users'),
  protocolVersion: v.string(),
  state: v.union(v.literal('initializing'), v.literal('ready'), v.literal('shutdown')),
  expiresAt: v.number(),
});

export const createSession = internalMutation({
  args: {
    userId: v.id('users'),
    protocolVersion: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const sessionId = crypto.randomUUID();
    const expiresAt = Date.now() + SESSION_TTL_MS;

    await ctx.db.insert('mcpSessions', {
      sessionId,
      userId: args.userId,
      protocolVersion: args.protocolVersion,
      state: 'initializing',
      expiresAt,
    });

    await ctx.scheduler.runAt(expiresAt, internal.mcp.session.cleanupSession, { sessionId });

    return sessionId;
  },
});

export const getSession = internalQuery({
  args: { sessionId: v.string() },
  returns: v.union(mcpSessionValidator, v.null()),
  handler: async (ctx, args): Promise<Doc<'mcpSessions'> | null> => {
    const session = await ctx.db
      .query('mcpSessions')
      .withIndex('by_session_id', (q) => q.eq('sessionId', args.sessionId))
      .first();

    if (!session) {
      return null;
    }

    if (session.expiresAt < Date.now()) {
      return null;
    }

    return session;
  },
});

export const getSessionInternal = internalQuery({
  args: { sessionId: v.string() },
  returns: v.union(mcpSessionValidator, v.null()),
  handler: async (ctx, args): Promise<Doc<'mcpSessions'> | null> => {
    const session = await ctx.db
      .query('mcpSessions')
      .withIndex('by_session_id', (q) => q.eq('sessionId', args.sessionId))
      .first();

    if (!session || session.expiresAt < Date.now()) {
      return null;
    }

    return session;
  },
});

export const updateSessionState = internalMutation({
  args: {
    sessionId: v.string(),
    state: v.union(v.literal('initializing'), v.literal('ready'), v.literal('shutdown')),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<void> => {
    const session = await ctx.db
      .query('mcpSessions')
      .withIndex('by_session_id', (q) => q.eq('sessionId', args.sessionId))
      .first();

    if (!session) {
      throw new Error('Session not found');
    }

    await ctx.db.patch(session._id, { state: args.state });
  },
});

export const deleteSession = internalMutation({
  args: { sessionId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<void> => {
    const session = await ctx.db
      .query('mcpSessions')
      .withIndex('by_session_id', (q) => q.eq('sessionId', args.sessionId))
      .first();

    if (session) {
      await ctx.db.delete(session._id);
    }
  },
});

export const getUserSessions = internalQuery({
  args: { userId: v.id('users') },
  returns: v.array(mcpSessionValidator),
  handler: async (ctx, args): Promise<Doc<'mcpSessions'>[]> => {
    return await ctx.db
      .query('mcpSessions')
      .withIndex('by_user_id', (q) => q.eq('userId', args.userId))
      .collect();
  },
});

export const cleanupSession = internalMutation({
  args: { sessionId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<void> => {
    const session = await ctx.db
      .query('mcpSessions')
      .withIndex('by_session_id', (q) => q.eq('sessionId', args.sessionId))
      .first();

    if (session && session.expiresAt <= Date.now()) {
      await ctx.db.delete(session._id);
    }
  },
});
