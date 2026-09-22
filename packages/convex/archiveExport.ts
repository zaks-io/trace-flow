import { SignJWT } from 'jose';
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { action, internalMutation, internalQuery } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { getActiveOrganizationMembership, requireEnabledUser } from './auth/users';
import { appendArchiveAuditEvent } from './archiveAuditLib';
import { isArchiveCanonicalIdentifier } from '@trace-flow/types';

const EXPORT_GRANT_ISSUER = 'trace-flow-convex';
const EXPORT_GRANT_AUDIENCE = 'trace-flow-archive-api';
const EXPORT_GRANT_SCOPE = 'archive:export';
const TARGET_EXPORT_GRANT_TTL_SECONDS = 10 * 60;
const ORGANIZATION_EXPORT_GRANT_TTL_SECONDS = 24 * 60 * 60;
const MAX_EXPORT_TARGETS = 64;

const source = v.union(v.literal('claude'), v.literal('codex'));
const requestedTarget = v.object({
  contributionId: v.id('archiveContributions'),
  source,
  sourceSessionId: v.string(),
});
const authorizedTarget = v.object({
  userId: v.id('users'),
  contributionId: v.id('archiveContributions'),
  source,
  sourceSessionId: v.string(),
});

interface RequestedTarget {
  contributionId: Id<'archiveContributions'>;
  source: 'claude' | 'codex';
  sourceSessionId: string;
}

function validExportId(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
}

function exportSecret(): Uint8Array {
  const secret = process.env.ARCHIVE_API_SHARED_SECRET;
  if (!secret) throw new Error('ARCHIVE_API_SHARED_SECRET environment variable is not set');
  return new TextEncoder().encode(secret);
}

function archiveApiUrl(): string {
  const value = process.env.ARCHIVE_API_URL;
  if (!value) throw new Error('ARCHIVE_API_URL environment variable is not set');
  return value.replace(/\/$/u, '');
}

export const authorize = internalQuery({
  args: {
    scope: v.optional(v.literal('organization')),
    targets: v.optional(v.array(requestedTarget)),
  },
  returns: v.object({
    orgId: v.id('organizations'),
    actorUserId: v.id('users'),
    exportScope: v.union(v.literal('organization'), v.literal('targets')),
    targets: v.optional(v.array(authorizedTarget)),
  }),
  handler: async (ctx, args) => {
    const organization = args.scope === 'organization';
    if (organization === (args.targets !== undefined)) {
      throw new Error('Archive export must select organization scope or explicit targets');
    }
    if (
      args.targets !== undefined &&
      (args.targets.length < 1 || args.targets.length > MAX_EXPORT_TARGETS)
    ) {
      throw new Error('Archive export must select between 1 and 64 sessions');
    }
    const user = await requireEnabledUser(ctx);
    const active = await getActiveOrganizationMembership(ctx, user);
    if (active?.membership.role !== 'owner' || active?.organization.ownerId !== user._id) {
      throw new Error('Only the organization owner can export Conversation Archive');
    }

    if (organization) {
      return {
        orgId: active.orgId,
        actorUserId: user._id,
        exportScope: 'organization' as const,
      };
    }

    const targets: {
      userId: Id<'users'>;
      contributionId: Id<'archiveContributions'>;
      source: 'claude' | 'codex';
      sourceSessionId: string;
    }[] = [];
    const seen = new Set<string>();
    for (const target of args.targets!) {
      if (!isArchiveCanonicalIdentifier(target.sourceSessionId)) {
        throw new Error('Invalid archive session id');
      }
      const identity = `${target.contributionId}\0${target.source}\0${target.sourceSessionId}`;
      if (seen.has(identity)) throw new Error('Duplicate archive export target');
      seen.add(identity);
      const contribution = await ctx.db.get(target.contributionId);
      if (contribution?.orgId !== active.orgId) {
        throw new Error('Archive export target not found');
      }
      targets.push({
        userId: contribution.userId,
        contributionId: contribution._id,
        source: target.source,
        sourceSessionId: target.sourceSessionId,
      });
    }
    return {
      orgId: active.orgId,
      actorUserId: user._id,
      exportScope: 'targets' as const,
      targets,
    };
  },
});

export const recordIssuance = internalMutation({
  args: {
    orgId: v.id('organizations'),
    actorUserId: v.id('users'),
    exportId: v.string(),
    targetCount: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await appendArchiveAuditEvent(ctx, {
      orgId: args.orgId,
      actorKind: 'user',
      actorUserId: args.actorUserId,
      action: 'export_grant_issuance',
      outcome: 'success',
      operationId: `export:${args.exportId}`,
      targetKind: 'export',
      targetId: args.exportId,
      relevantCount: args.targetCount,
    });
    return null;
  },
});

const authorizeRef = makeFunctionReference<
  'query',
  { scope?: 'organization'; targets?: RequestedTarget[] },
  {
    orgId: Id<'organizations'>;
    actorUserId: Id<'users'>;
    exportScope: 'organization' | 'targets';
    targets?: {
      userId: Id<'users'>;
      contributionId: Id<'archiveContributions'>;
      source: 'claude' | 'codex';
      sourceSessionId: string;
    }[];
  }
>('archiveExport:authorize');

const recordIssuanceRef = makeFunctionReference<
  'mutation',
  {
    orgId: Id<'organizations'>;
    actorUserId: Id<'users'>;
    exportId: string;
    targetCount: number;
  },
  null
>('archiveExport:recordIssuance');

export const issueGrant = action({
  args: {
    exportId: v.string(),
    scope: v.optional(v.literal('organization')),
    targets: v.optional(v.array(requestedTarget)),
  },
  returns: v.object({
    archiveUrl: v.string(),
    grant: v.string(),
    exportId: v.string(),
    expiresAt: v.number(),
  }),
  handler: async (ctx, args) => {
    if (!validExportId(args.exportId)) throw new Error('Invalid archive export id');
    const authorization = await ctx.runQuery(authorizeRef, {
      ...(args.scope === undefined ? {} : { scope: args.scope }),
      ...(args.targets === undefined ? {} : { targets: args.targets }),
    });
    const expiresAt =
      Math.floor(Date.now() / 1000) +
      (authorization.exportScope === 'organization'
        ? ORGANIZATION_EXPORT_GRANT_TTL_SECONDS
        : TARGET_EXPORT_GRANT_TTL_SECONDS);
    const grant = await new SignJWT({
      scope: EXPORT_GRANT_SCOPE,
      orgId: authorization.orgId,
      exportId: args.exportId,
      actorUserId: authorization.actorUserId,
      exportScope: authorization.exportScope,
      ...(authorization.targets === undefined ? {} : { targets: authorization.targets }),
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(EXPORT_GRANT_ISSUER)
      .setAudience(EXPORT_GRANT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .setJti(crypto.randomUUID())
      .sign(exportSecret());
    await ctx.runMutation(recordIssuanceRef, {
      orgId: authorization.orgId,
      actorUserId: authorization.actorUserId,
      exportId: args.exportId,
      targetCount: authorization.targets?.length ?? 0,
    });
    return { archiveUrl: archiveApiUrl(), grant, exportId: args.exportId, expiresAt };
  },
});
