import { describe, expect, it } from 'vitest';
import { makeFunctionReference } from 'convex/server';
import { internal } from '../_generated/api';
import { initConvexTest } from './convexTest.setup';

const begin = makeFunctionReference<'mutation'>('agentIngestionMigration:begin');
const complete = makeFunctionReference<'mutation'>('agentIngestionMigration:complete');
const list = makeFunctionReference<'query'>('agentIngestionMigration:listOrganizations');
const migrationId = 'bounded-agent-ingestion-v1';

async function fixture() {
  const t = initConvexTest();
  const orgId = await t.run(async (ctx) => {
    const ownerId = await ctx.db.insert('users', {
      email: 'migration@example.com',
      tokenIdentifier: 'migration',
      enabled: true,
    });
    return ctx.db.insert('organizations', { name: 'Migration', ownerId });
  });
  return { t, orgId };
}

describe('organization ingestion migration', () => {
  it('serializes migration with deletion and releases only the matching lock', async () => {
    const { t, orgId } = await fixture();
    await expect(t.mutation(begin, { orgId, migrationId })).resolves.toBe(true);
    await expect(t.mutation(begin, { orgId, migrationId })).resolves.toBe(true);
    await expect(t.mutation(internal.admin.admin.beginOrgDeletion, { orgId })).rejects.toThrow(
      'migration must finish',
    );
    await expect(t.mutation(complete, { orgId, migrationId: 'wrong' })).rejects.toThrow(
      'lock mismatch',
    );
    await expect(t.mutation(complete, { orgId, migrationId })).resolves.toBeNull();
    await expect(t.mutation(complete, { orgId, migrationId })).resolves.toBeNull();
    await t.mutation(internal.admin.admin.beginOrgDeletion, { orgId });
    await expect(t.mutation(begin, { orgId, migrationId })).resolves.toBe(false);
  });

  it.each(['deletionStartedAt', 'deletedAt'] as const)(
    'excludes %s organizations but includes empty active organizations',
    async (field) => {
      const { t, orgId } = await fixture();
      expect((await t.query(list, { cursor: null })).organizations).toEqual([orgId]);
      await t.run((ctx) => ctx.db.patch(orgId, { [field]: 1 }));
      expect((await t.query(list, { cursor: null })).organizations).toEqual([]);
      await expect(t.mutation(begin, { orgId, migrationId })).resolves.toBe(false);
    },
  );
});
