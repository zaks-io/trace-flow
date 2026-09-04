import { internalMutation, internalQuery } from './_generated/server';
import { parseArchiveWrappedKeyVersion } from '@trace-flow/utils';
import { v } from 'convex/values';

const archiveKeyVersionValidator = v.object({
  orgId: v.id('organizations'),
  keyVersion: v.number(),
  wrappedKey: v.string(),
});

function assertKeyVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error('Archive key version is invalid');
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

    const org = await ctx.db.get(args.orgId);
    if (!org || org.deletedAt || org.deletionStartedAt) {
      throw new Error('Organization not found');
    }

    const existing = await ctx.db
      .query('archiveEncryptionKeyVersions')
      .withIndex('by_org_version', (q) =>
        q.eq('orgId', args.orgId).eq('keyVersion', args.keyVersion),
      )
      .first();
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
    const record = await ctx.db
      .query('archiveEncryptionKeyVersions')
      .withIndex('by_org_version', (q) =>
        q.eq('orgId', args.orgId).eq('keyVersion', args.keyVersion),
      )
      .first();
    if (!record) return null;
    return {
      orgId: record.orgId,
      keyVersion: record.keyVersion,
      wrappedKey: record.wrappedKey,
    };
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
    const record = await ctx.db
      .query('archiveEncryptionKeyVersions')
      .withIndex('by_org_version', (q) =>
        q.eq('orgId', args.orgId).eq('keyVersion', args.keyVersion),
      )
      .first();
    if (!record) return false;
    await ctx.db.delete(record._id);
    return true;
  },
});
