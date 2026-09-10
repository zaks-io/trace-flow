import { describe, expect, it } from 'vitest';
import { makeFunctionReference } from 'convex/server';
import { initConvexTest } from './convexTest.setup';
import { selectArchiveLedgerNamespace } from '../archiveErasure';
import type { Id } from '../_generated/dataModel';

const destroyArchiveKeys = makeFunctionReference<
  'mutation',
  { orgId: Id<'organizations'> },
  { keyVersionsDeleted: number; custodyDeleted: number; hasMore: boolean }
>('archiveErasure:destroyArchiveKeys');

describe('archive erasure control plane', () => {
  it('selects only the exact Worker and ledger class namespace', () => {
    expect(
      selectArchiveLedgerNamespace(
        [
          { id: 'wrong-class', script: 'trace-flow-archive-api', class: 'StorageBudget' },
          {
            id: 'wrong-worker',
            script: 'trace-flow-archive-api-dev',
            class: 'ArchiveSessionLedger',
          },
          { id: 'ledger', script: 'trace-flow-archive-api', class: 'ArchiveSessionLedger' },
        ],
        'trace-flow-archive-api',
      ),
    ).toBe('ledger');
  });

  it('fails closed when namespace metadata is missing or ambiguous', () => {
    expect(() => selectArchiveLedgerNamespace([], 'trace-flow-archive-api')).toThrow(
      'Expected one ArchiveSessionLedger namespace',
    );
    expect(() =>
      selectArchiveLedgerNamespace(
        [
          { id: 'one', script: 'trace-flow-archive-api', class: 'ArchiveSessionLedger' },
          { id: 'two', script: 'trace-flow-archive-api', class: 'ArchiveSessionLedger' },
        ],
        'trace-flow-archive-api',
      ),
    ).toThrow('Expected one ArchiveSessionLedger namespace');
  });

  it('deletes every wrapped key version and custody row idempotently', async () => {
    const t = initConvexTest();
    const orgId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert('users', {
        tokenIdentifier: 'archive-erasure-owner',
        email: 'owner@example.com',
        enabled: true,
      });
      const id = await ctx.db.insert('organizations', { name: 'Archive Org', ownerId: userId });
      for (let keyVersion = 1; keyVersion <= 3; keyVersion += 1) {
        await ctx.db.insert('archiveEncryptionKeyVersions', {
          orgId: id,
          keyVersion,
          wrappedKey: `wrapped-${keyVersion}`,
          createdAt: keyVersion,
        });
      }
      await ctx.db.insert('archiveEncryptionCustody', {
        orgId: id,
        activeKeyVersion: 3,
        updatedAt: 3,
      });
      return id;
    });

    expect(await t.mutation(destroyArchiveKeys, { orgId })).toEqual({
      keyVersionsDeleted: 3,
      custodyDeleted: 1,
      hasMore: false,
    });
    expect(await t.mutation(destroyArchiveKeys, { orgId })).toEqual({
      keyVersionsDeleted: 0,
      custodyDeleted: 0,
      hasMore: false,
    });
    await t.run(async (ctx) => {
      expect(await ctx.db.query('archiveEncryptionKeyVersions').collect()).toHaveLength(0);
      expect(await ctx.db.query('archiveEncryptionCustody').collect()).toHaveLength(0);
    });
  });
});
