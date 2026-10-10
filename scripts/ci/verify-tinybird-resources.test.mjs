import { test, expect } from 'bun:test';
import { readdirSync } from 'node:fs';
import { verifyTinybirdResources } from './verify-tinybird-resources.mjs';
const inventory = {
  tokens: [],
  datasources: readdirSync('datasources')
    .filter((name) => name.endsWith('.datasource'))
    .map((name) => ({ name: name.slice(0, -11) })),
  pipes: ['pipes', 'materializations', 'copies'].flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith('.pipe'))
      .map((name) => ({ name: name.slice(0, -5) })),
  ),
};
const verify = (resources) =>
  verifyTinybirdResources({
    host: 'https://tinybird.test',
    token: 'test-only',
    fetchImpl: async (url, options) => {
      expect(options).not.toHaveProperty('method');
      const kind = url.pathname.slice(4);
      return Response.json({ [kind]: resources[kind] });
    },
  });
test('verifies every repository resource through read-only provider inventories', async () => {
  await verify(inventory);
});
test('rejects a missing live resource and a retained retired resource', async () => {
  await expect(
    verify({ ...inventory, datasources: inventory.datasources.slice(1) }),
  ).rejects.toThrow('Missing live');
  await expect(
    verify({ ...inventory, pipes: [...inventory.pipes, { name: 'otel_traces_mv' }] }),
  ).rejects.toThrow('Retired Tinybird');
});

test('verifies retired tokens are absent without logging token values', async () => {
  await expect(
    verify({ ...inventory, tokens: [{ name: 'agent_snapshot_migration' }] }),
  ).rejects.toThrow('Retired Tinybird token');
});
