import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgentRecoveryClient, AgentTinybirdClient } from './agent-transport';
import { DATASOURCES } from './agent-data';

function client() {
  const file = join(mkdtempSync(join(tmpdir(), 'agent-target-test-')), 'config.json');
  writeFileSync(file, JSON.stringify({ host: 'http://localhost:7181', token: 'test-token' }), {
    mode: 0o600,
  });
  return new AgentTinybirdClient(file);
}

test('workspace proof hashes credentials without returning token material', async () => {
  const tinybird = client();
  tinybird.request = async () => ({
    tokens: [{ token: 'append-secret' }, { token: 'append-secret' }],
  });
  expect(await tinybird.tokenFingerprints()).toEqual([
    createHash('sha256').update('append-secret').digest('hex'),
  ]);
});

test('recovery rejects a different workspace or host and binds executor identity', async () => {
  let fingerprint = 'a'.repeat(64);
  let host = 'http://localhost:7181';
  let request: any;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(incoming) {
      request = await incoming.json();
      return Response.json({
        status: 'quiescent',
        tinybirdHost: host,
        tinybirdTokenFingerprint: fingerprint,
        tinybirdWorkspaceId: 'workspace',
      });
    },
  });
  try {
    const recovery = new AgentRecoveryClient('org', `http://127.0.0.1:${server.port}`);
    recovery.bindExecutor('executor', () => {});
    recovery.bindWorkspace(host, 'workspace', [fingerprint]);
    await recovery.call('beginFactRebuild', { operationId: 'operation' });
    expect(request.options.executorId).toBe('executor');
    expect(request.options.tinybirdTokenFingerprints).toEqual([fingerprint]);
    fingerprint = 'b'.repeat(64);
    await expect(recovery.call('beginFactRebuild', {})).rejects.toThrow('workspace');
    fingerprint = 'a'.repeat(64);
    host = 'https://another.example';
    await expect(recovery.call('beginFactRebuild', {})).rejects.toThrow('workspace');
  } finally {
    server.stop(true);
  }
});

test('graph validation refuses absent materializations or canonical datasources', async () => {
  const tinybird = client();
  tinybird.request = async (path) =>
    path === '/v0/datasources'
      ? { datasources: Object.values(DATASOURCES).map((name) => ({ name })) }
      : { pipes: [] };
  const root = resolve(import.meta.dir, '../..');
  await expect(tinybird.graph(Object.values(DATASOURCES), root)).rejects.toThrow(
    'Missing deployed agent materialization',
  );
  tinybird.request = async (path) =>
    path === '/v0/datasources'
      ? { datasources: [] }
      : {
          pipes: readdirSync(join(root, 'materializations'))
            .filter((name) => name.startsWith('materialize_agent_'))
            .map((name) => ({ name: name.slice(0, -5), type: 'materialized' })),
        };
  await expect(tinybird.graph(Object.values(DATASOURCES), root)).rejects.toThrow(
    'Missing canonical table',
  );
});

test('recovery reads retry temporary bridge failures with the same page cursor', async () => {
  const requests: any[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requests.push(await request.json());
      return requests.length < 3
        ? new Response('Unavailable', { status: requests.length === 1 ? 503 : 502 })
        : Response.json({ records: [], nextAfterId: null });
    },
  });
  try {
    const recovery = new AgentRecoveryClient('org', `http://127.0.0.1:${server.port}`);
    const options = { afterId: 123, state: 'blocked', limit: 100 };
    expect(await recovery.call('listRecovery', options)).toEqual({
      records: [],
      nextAfterId: null,
    });
    expect(requests).toHaveLength(3);
    expect(
      requests.every((request) => JSON.stringify(request.options) === JSON.stringify(options)),
    ).toBe(true);
  } finally {
    server.stop(true);
  }
});

test('recovery fails after bounded read retries and never retries uncertain mutations', async () => {
  let count = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      count++;
      return new Response('Unavailable', { status: 502 });
    },
  });
  try {
    const recovery = new AgentRecoveryClient('org', `http://127.0.0.1:${server.port}`);
    await expect(recovery.call('listRebuildFacts', {})).rejects.toThrow('HTTP 502');
    expect(count).toBe(3);
    for (const method of [
      'beginFactRebuild',
      'completeFactRebuild',
      'replayDlq',
      'reconcileRecovery',
    ]) {
      count = 0;
      await expect(recovery.call(method, {})).rejects.toThrow('HTTP 502');
      expect(count).toBe(1);
    }
  } finally {
    server.stop(true);
  }
});
