#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgentSnapshot, CATEGORIES, DATASOURCES, identity, stableHash, quote } from './agent-data';
import { captureSnapshot } from './agent-snapshot';
import { rebuild, RebuildJournal, validateSnapshot, reconcileDeleteJob } from './agent-rebuild';
import { AgentTinybirdClient, type AgentRecoveryClient } from './agent-transport';
import { batchContext, messageRow, toolEventRow } from '../../apps/agent-consumer/src/rows';
import {
  messageFact,
  toolEventFact,
  queueMessage,
} from '../../apps/agent-consumer/src/__tests__/factories';

const config = process.argv[2];
if (!config) throw new Error('Pass a Tinybird Local config path');
const tinybird = new AgentTinybirdClient(config);
if (!['localhost', '127.0.0.1'].includes(new URL(tinybird.host).hostname))
  throw new Error('This smoke test requires Tinybird Local');
const org = `rebuild-test-${crypto.randomUUID()}`;
const control = `${org}-control`;
const operationId = crypto.randomUUID();
const dir = mkdtempSync(join(tmpdir(), 'trace-flow-rebuild-smoke-'));
const ctx = batchContext(queueMessage());
const old = { ...messageRow(ctx, messageFact({ output_tokens: 1 }), 0.01), OrgId: org };
const corrected = { ...old, output_tokens: 42 };
const missing = { ...old, message_pk: 'missing-message', output_tokens: 7 };
const tool = { ...toolEventRow(ctx, toolEventFact()), OrgId: org };
const controlRow = { ...old, OrgId: control, output_tokens: 500 };
for (const [table, rows] of [
  [DATASOURCES.messages, [old, old, controlRow]],
  [DATASOURCES.tool_events, [tool]],
] as const) {
  const receipt = await tinybird.request(
    `/v0/events?name=${table}&wait=true`,
    rows.map((row) => JSON.stringify(row)).join('\n'),
  );
  assert.equal(receipt.successful_rows, rows.length);
  assert.equal(receipt.quarantined_rows, 0);
}
const ledger = [
  { category: 'messages', row: old },
  { category: 'messages', row: missing },
  { category: 'tool_events', row: tool },
].map(({ category, row }) => ({
  category,
  factId: identity(category as any, row, org),
  contentHash: stableHash(row),
  payload: JSON.stringify(row),
  missingPayload: false,
  pending: [],
}));
const repair = {
  id: 1,
  kind: 'repair',
  payload: JSON.stringify(corrected),
  outcome: JSON.stringify({
    category: 'messages',
    factId: ledger[0]!.factId,
    oldHash: stableHash(old),
    newHash: stableHash(corrected),
  }),
};
const stages: any[] = [];
let finalized = false;
const recovery = {
  org,
  async call(method: string, input: any) {
    if (method === 'beginFactRebuild') return { status: 'quiescent' };
    if (method === 'listRebuildFacts') return { facts: ledger, nextAfter: null };
    if (method === 'listRecovery') return { records: [repair], nextAfterId: null };
    assert.equal(method, 'completeFactRebuild');
    assert.equal(input.operationId, operationId);
    if (input.phase === 'stage') stages.push(input);
    else finalized = true;
    return {};
  },
} as unknown as AgentRecoveryClient;
const graph = await tinybird.graph(Object.values(DATASOURCES), resolve(import.meta.dir, '../..'));
assert.equal(graph.facts.length, CATEGORIES.length);
assert.equal(graph.derived.length, 9);
const snapshot = new AgentSnapshot(join(dir, 'snapshot.sqlite'), true);
try {
  await captureSnapshot(snapshot, tinybird, recovery, operationId, graph);
  await validateSnapshot(snapshot, tinybird);
  const request = tinybird.request.bind(tinybird);
  let lostReceipt = false;
  let lostDeleteJob: string | undefined;
  tinybird.request = async (path, body) => {
    const response = await request(path, body);
    if (!lostDeleteJob && path.endsWith('/delete')) {
      lostDeleteJob = response.job_id;
      throw new Error('simulated lost delete receipt');
    }
    if (!lostReceipt && path.startsWith('/v0/events')) {
      lostReceipt = true;
      throw new Error('simulated lost insert receipt');
    }
    return response;
  };
  const journal = new RebuildJournal(join(dir, 'journal.json'), operationId);
  await assert.rejects(
    () => rebuild(snapshot, tinybird, recovery, journal, 'Local integration test', 'a'.repeat(64)),
    /simulated lost delete receipt/,
  );
  assert(lostDeleteJob);
  await reconcileDeleteJob(tinybird, journal, org, graph.facts[0]!, lostDeleteJob);
  await assert.rejects(
    () => rebuild(snapshot, tinybird, recovery, journal, 'Local integration test', 'a'.repeat(64)),
    /simulated lost insert receipt/,
  );
  assert(lostReceipt);
  tinybird.request = request;
  await rebuild(
    snapshot,
    tinybird,
    recovery,
    new RebuildJournal(join(dir, 'journal.json'), operationId),
    'Local integration test',
    'a'.repeat(64),
  );
  assert(finalized);
  assert.equal(stages.flatMap((stage) => stage.confirmations).length, 3);
  const controlData = await tinybird.sql(
    `SELECT output_tokens FROM agent_message_facts WHERE OrgId=${quote(control)}`,
  );
  assert.deepEqual(controlData.data, [{ output_tokens: 500 }]);
  const repaired = await tinybird.sql(
    `SELECT count() AS count, sum(output_tokens) AS output FROM agent_message_facts WHERE OrgId=${quote(org)}`,
  );
  assert.equal(String(repaired.data[0]!.count), '2');
  assert.equal(String(repaired.data[0]!.output), '49');
  console.log(
    JSON.stringify({
      status: 'passed',
      org,
      correctedOutputTokens: 49,
      messageCount: 2,
      controlUnchanged: true,
      backup: dir,
    }),
  );
} finally {
  snapshot.db.close();
}
