import { expect, test } from 'bun:test';
import type { AgentTinybirdClient } from './agent-transport';
import { verifyMigrationTarget } from './agent-migration-target';

const fingerprint = 'a'.repeat(64);
const tb = {
  host: 'https://tinybird.test',
  tokenFingerprints: async () => [fingerprint],
} as unknown as AgentTinybirdClient;
test('migration binds parity reads to the deployed consumer workspace without exposing its token', async () => {
  await expect(
    verifyMigrationTarget(tb, { tinybirdHost: tb.host, appendTokenSha256: fingerprint }),
  ).resolves.toBeUndefined();
  await expect(
    verifyMigrationTarget(tb, { tinybirdHost: tb.host, appendTokenSha256: 'b'.repeat(64) }),
  ).rejects.toThrow('deployed consumer workspace');
  await expect(
    verifyMigrationTarget(tb, {
      tinybirdHost: 'https://other.test',
      appendTokenSha256: fingerprint,
    }),
  ).rejects.toThrow('mismatched');
  await expect(verifyMigrationTarget(tb, undefined)).rejects.toThrow('missing');
});
