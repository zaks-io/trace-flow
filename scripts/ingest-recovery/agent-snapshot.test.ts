import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSnapshot, DATASOURCES, identity, stableHash } from './agent-data';
import { captureSnapshot, confirmations } from './agent-snapshot';
import type { AgentRecoveryClient, AgentTinybirdClient } from './agent-transport';

const opened: AgentSnapshot[] = [];
afterEach(() => {
  for (const snapshot of opened.splice(0)) snapshot.db.close();
});

function fixture(receipt: 'matching' | 'absent' | 'mismatched') {
  const snapshot = new AgentSnapshot(
    join(mkdtempSync(join(tmpdir(), 'agent-snapshot-test-')), 'snapshot.sqlite'),
    true,
  );
  opened.push(snapshot);
  const old = { OrgId: 'org', session_pk: 'session', message_pk: 'message', output_tokens: 1 };
  const corrected = { ...old, output_tokens: 42 };
  const factId = identity('messages', old, 'org');
  const oldHash = stableHash(old);
  const newHash = stableHash(corrected);
  const payload = JSON.stringify(corrected);
  const tinybird = {
    host: 'https://example.test',
    async *rows(table: string) {
      if (table === DATASOURCES.messages) yield old;
    },
  } as unknown as AgentTinybirdClient;
  const recovery = {
    org: 'org',
    matchedWorkspaceId: 'workspace',
    async call(method: string) {
      if (method === 'listRebuildFacts')
        return {
          facts: [
            {
              category: 'messages',
              factId,
              contentHash: oldHash,
              payload: null,
              missingPayload: true,
              pending: [],
              replacement: { contentHash: newHash, payload, recoveryId: 1 },
            },
          ],
        };
      if (method === 'listRecovery')
        return {
          records:
            receipt === 'absent'
              ? []
              : [
                  {
                    id: 1,
                    kind: 'repair',
                    payload: receipt === 'mismatched' ? JSON.stringify(old) : payload,
                    outcome: JSON.stringify({
                      category: 'messages',
                      factId,
                      oldHash,
                      newHash: receipt === 'mismatched' ? oldHash : newHash,
                    }),
                  },
                ],
        };
      throw new Error(`Unexpected method ${method}`);
    },
  } as unknown as AgentRecoveryClient;
  const capture = () =>
    captureSnapshot(snapshot, tinybird, recovery, 'operation', {
      facts: Object.values(DATASOURCES),
      derived: [],
      definitionHashInput: 'graph',
    });
  return { snapshot, capture, factId, oldHash, newHash, corrected };
}

test('backs up a verified replacement while preserving the original ledger hash', async () => {
  const { snapshot, capture, factId, oldHash, newHash, corrected } = fixture('matching');
  await capture();
  expect(snapshot.meta('complete')).toBe(true);
  expect(snapshot.get('messages', factId)?.old_hash).toBe(oldHash);
  expect([...confirmations(snapshot, 'messages')]).toEqual([
    { category: 'messages', factId, expectedOldHash: oldHash, newHash, row: corrected },
  ]);
  expect(snapshot.db.query('SELECT COUNT(*) AS count FROM recovery').get()).toEqual({ count: 1 });
});

for (const receipt of ['absent', 'mismatched'] as const) {
  test(`does not complete a snapshot with a ${receipt} replacement receipt`, async () => {
    const { snapshot, capture } = fixture(receipt);
    await expect(capture()).rejects.toThrow('Repair replacement receipt');
    expect(() => snapshot.meta('complete')).toThrow('metadata missing');
    expect(snapshot.db.query('SELECT COUNT(*) AS count FROM originals').get()).toEqual({
      count: 1,
    });
  });
}
