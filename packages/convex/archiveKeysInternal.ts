import { internalMutation, internalQuery } from './_generated/server';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { parseArchiveWrappedKeyVersion } from '@trace-flow/utils';
import { v } from 'convex/values';
import { getArchiveActivation } from './archiveLib';

const archiveKeyVersionValidator = v.object({
  orgId: v.id('organizations'),
  keyVersion: v.number(),
  wrappedKey: v.string(),
});

const archiveKeyCustodyValidator = v.object({
  orgId: v.id('organizations'),
  activeKeyVersion: v.number(),
  retiringKeyVersion: v.optional(v.number()),
  rotationOperationId: v.optional(v.string()),
  rotationStatus: v.optional(
    v.union(v.literal('rotating'), v.literal('succeeded'), v.literal('failed')),
  ),
});

const archiveActiveKeyValidator = v.object({
  orgId: v.id('organizations'),
  keyVersion: v.number(),
  wrappedKey: v.string(),
  retiringKeyVersion: v.optional(v.number()),
  rotationOperationId: v.optional(v.string()),
  rotationStatus: v.optional(
    v.union(v.literal('rotating'), v.literal('succeeded'), v.literal('failed')),
  ),
});

const archiveActivateResultValidator = v.object({
  orgId: v.id('organizations'),
  fromVersion: v.number(),
  toVersion: v.number(),
  replay: v.boolean(),
  activationId: v.optional(v.id('archiveActivations')),
  operationId: v.string(),
});

function assertKeyVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error('Archive key version is invalid');
  }
}

function assertOperationId(operationId: string): void {
  if (operationId.length === 0 || operationId.length > 256) {
    throw new Error('Archive key rotation operation id is invalid');
  }
}

function isValidStoredWrappedKey(
  wrappedKey: string,
  expected: { orgId: string; keyVersion: number },
): boolean {
  try {
    parseArchiveWrappedKeyVersion(wrappedKey, expected);
    return true;
  } catch {
    return false;
  }
}

async function assertLiveOrganization(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<'organizations'>,
): Promise<void> {
  const org = await ctx.db.get(orgId);
  if (!org || org.deletedAt || org.deletionStartedAt) {
    throw new Error('Organization not found');
  }
}

async function getKeyRecord(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<'organizations'>,
  keyVersion: number,
): Promise<Doc<'archiveEncryptionKeyVersions'> | null> {
  return await ctx.db
    .query('archiveEncryptionKeyVersions')
    .withIndex('by_org_version', (q) => q.eq('orgId', orgId).eq('keyVersion', keyVersion))
    .first();
}

async function getCustodyRow(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<'organizations'>,
): Promise<Doc<'archiveEncryptionCustody'> | null> {
  return await ctx.db
    .query('archiveEncryptionCustody')
    .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
    .first();
}

async function ensureCustodyForStoredVersion(
  ctx: MutationCtx,
  orgId: Id<'organizations'>,
  keyVersion: number,
): Promise<void> {
  const existing = await getCustodyRow(ctx, orgId);
  if (existing) return;
  await ctx.db.insert('archiveEncryptionCustody', {
    orgId,
    activeKeyVersion: keyVersion,
    updatedAt: Date.now(),
  });
}

async function upsertStoredVersion(
  ctx: MutationCtx,
  args: { orgId: Id<'organizations'>; keyVersion: number; wrappedKey: string },
): Promise<Id<'archiveEncryptionKeyVersions'>> {
  const existing = await getKeyRecord(ctx, args.orgId, args.keyVersion);
  if (existing) {
    if (!isValidStoredWrappedKey(existing.wrappedKey, args)) {
      await ctx.db.patch(existing._id, { wrappedKey: args.wrappedKey });
      return existing._id;
    }
    if (existing.wrappedKey !== args.wrappedKey) {
      throw new Error('Archive key version already exists');
    }
    return existing._id;
  }
  return await ctx.db.insert('archiveEncryptionKeyVersions', {
    orgId: args.orgId,
    keyVersion: args.keyVersion,
    wrappedKey: args.wrappedKey,
    createdAt: Date.now(),
  });
}

export const storeVersion = internalMutation({
  args: {
    orgId: v.id('organizations'),
    keyVersion: v.number(),
    wrappedKey: v.string(),
  },
  returns: v.id('archiveEncryptionKeyVersions'),
  handler: async (ctx, args) => {
    assertKeyVersion(args.keyVersion);
    parseArchiveWrappedKeyVersion(args.wrappedKey, args);
    await assertLiveOrganization(ctx, args.orgId);
    const id = await upsertStoredVersion(ctx, args);
    await ensureCustodyForStoredVersion(ctx, args.orgId, args.keyVersion);
    return id;
  },
});

export const getVersion = internalQuery({
  args: {
    orgId: v.id('organizations'),
    keyVersion: v.number(),
  },
  returns: v.union(archiveKeyVersionValidator, v.null()),
  handler: async (ctx, args) => {
    assertKeyVersion(args.keyVersion);
    const record = await getKeyRecord(ctx, args.orgId, args.keyVersion);
    if (!record) return null;
    return {
      orgId: record.orgId,
      keyVersion: record.keyVersion,
      wrappedKey: record.wrappedKey,
    };
  },
});

export const getCustody = internalQuery({
  args: {
    orgId: v.id('organizations'),
  },
  returns: v.union(archiveKeyCustodyValidator, v.null()),
  handler: async (ctx, args) => {
    const custody = await getCustodyRow(ctx, args.orgId);
    if (!custody) return null;
    return {
      orgId: custody.orgId,
      activeKeyVersion: custody.activeKeyVersion,
      ...(custody.retiringKeyVersion === undefined
        ? {}
        : { retiringKeyVersion: custody.retiringKeyVersion }),
      ...(custody.rotationOperationId === undefined
        ? {}
        : { rotationOperationId: custody.rotationOperationId }),
      ...(custody.rotationStatus === undefined ? {} : { rotationStatus: custody.rotationStatus }),
    };
  },
});

export const getActiveVersion = internalQuery({
  args: {
    orgId: v.id('organizations'),
  },
  returns: v.union(archiveActiveKeyValidator, v.null()),
  handler: async (ctx, args) => {
    const custody = await getCustodyRow(ctx, args.orgId);
    if (!custody) return null;
    const record = await getKeyRecord(ctx, args.orgId, custody.activeKeyVersion);
    if (!record) return null;
    return {
      orgId: record.orgId,
      keyVersion: record.keyVersion,
      wrappedKey: record.wrappedKey,
      ...(custody.retiringKeyVersion === undefined
        ? {}
        : { retiringKeyVersion: custody.retiringKeyVersion }),
      ...(custody.rotationOperationId === undefined
        ? {}
        : { rotationOperationId: custody.rotationOperationId }),
      ...(custody.rotationStatus === undefined ? {} : { rotationStatus: custody.rotationStatus }),
    };
  },
});

export const activateVersion = internalMutation({
  args: {
    orgId: v.id('organizations'),
    keyVersion: v.number(),
    wrappedKey: v.string(),
    operationId: v.string(),
  },
  returns: archiveActivateResultValidator,
  handler: async (ctx, args) => {
    assertKeyVersion(args.keyVersion);
    assertOperationId(args.operationId);
    parseArchiveWrappedKeyVersion(args.wrappedKey, args);
    await assertLiveOrganization(ctx, args.orgId);

    const activation = await getArchiveActivation(ctx, args.orgId);
    const existingCustody = await getCustodyRow(ctx, args.orgId);
    if (!existingCustody) {
      throw new Error('Archive key custody is not initialized');
    }
    const currentActive = existingCustody.activeKeyVersion;
    if (
      existingCustody.rotationOperationId === args.operationId &&
      existingCustody.activeKeyVersion === args.keyVersion
    ) {
      const stored = await getKeyRecord(ctx, args.orgId, args.keyVersion);
      if (stored?.wrappedKey !== args.wrappedKey) {
        throw new Error('Archive key rotation operation already exists');
      }
      return {
        orgId: args.orgId,
        fromVersion: existingCustody.retiringKeyVersion ?? currentActive,
        toVersion: args.keyVersion,
        replay: true,
        ...(activation ? { activationId: activation._id } : {}),
        operationId: args.operationId,
      };
    }
    if (existingCustody.activeKeyVersion === args.keyVersion) {
      const stored = await getKeyRecord(ctx, args.orgId, args.keyVersion);
      if (stored?.wrappedKey === args.wrappedKey) {
        return {
          orgId: args.orgId,
          fromVersion: existingCustody.retiringKeyVersion ?? currentActive,
          toVersion: args.keyVersion,
          replay: true,
          ...(activation ? { activationId: activation._id } : {}),
          operationId: existingCustody.rotationOperationId ?? args.operationId,
        };
      }
    }
    if (
      existingCustody.rotationStatus === 'rotating' &&
      existingCustody.rotationOperationId !== args.operationId
    ) {
      throw new Error('Archive key rotation already in progress');
    }
    if (args.keyVersion !== currentActive + 1) {
      throw new Error('Archive key version must increment by one');
    }

    await upsertStoredVersion(ctx, args);
    const now = Date.now();
    const nextCustody = {
      activeKeyVersion: args.keyVersion,
      retiringKeyVersion: currentActive,
      rotationOperationId: args.operationId,
      rotationStatus: 'rotating' as const,
      updatedAt: now,
    };
    await ctx.db.patch(existingCustody._id, nextCustody);
    return {
      orgId: args.orgId,
      fromVersion: currentActive,
      toVersion: args.keyVersion,
      replay: false,
      ...(activation ? { activationId: activation._id } : {}),
      operationId: args.operationId,
    };
  },
});

export const markRotationFailed = internalMutation({
  args: {
    orgId: v.id('organizations'),
    operationId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    assertOperationId(args.operationId);
    const custody = await getCustodyRow(ctx, args.orgId);
    if (custody?.rotationOperationId !== args.operationId) return false;
    if (custody.rotationStatus === 'failed') return true;
    await ctx.db.patch(custody._id, {
      rotationStatus: 'failed',
      updatedAt: Date.now(),
    });
    return true;
  },
});

export const destroyRetiringVersion = internalMutation({
  args: {
    orgId: v.id('organizations'),
    keyVersion: v.number(),
    operationId: v.string(),
    liveReferenceCount: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    assertKeyVersion(args.keyVersion);
    assertOperationId(args.operationId);
    if (!Number.isSafeInteger(args.liveReferenceCount) || args.liveReferenceCount < 0) {
      throw new Error('Archive key live reference count is invalid');
    }
    const custody = await getCustodyRow(ctx, args.orgId);
    if (!custody) throw new Error('Archive key custody is not initialized');
    if (custody.activeKeyVersion === args.keyVersion) {
      throw new Error('Active archive key cannot be destroyed');
    }
    if (custody.rotationOperationId !== args.operationId) {
      throw new Error('Archive key rotation operation does not match');
    }
    if (custody.retiringKeyVersion !== args.keyVersion) {
      const alreadyGone = (await getKeyRecord(ctx, args.orgId, args.keyVersion)) === null;
      return alreadyGone && custody.rotationStatus === 'succeeded';
    }
    if (args.liveReferenceCount !== 0) {
      throw new Error('Archive key still has live object references');
    }
    const record = await getKeyRecord(ctx, args.orgId, args.keyVersion);
    if (record) await ctx.db.delete(record._id);
    await ctx.db.patch(custody._id, {
      retiringKeyVersion: undefined,
      rotationStatus: 'succeeded',
      updatedAt: Date.now(),
    });
    return true;
  },
});

export const destroyVersion = internalMutation({
  args: {
    orgId: v.id('organizations'),
    keyVersion: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    assertKeyVersion(args.keyVersion);
    const record = await getKeyRecord(ctx, args.orgId, args.keyVersion);
    if (!record) return false;
    await ctx.db.delete(record._id);
    return true;
  },
});
