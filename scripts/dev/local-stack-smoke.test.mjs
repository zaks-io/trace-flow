import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('./local-stack-smoke.mjs', import.meta.url));
const registeredKey = '00000000-0000-4000-8000-000000000001';
const analyticsKey = 'sha256:11e594f481958c10e3015d0bf0447a22f068a8a647f475df15ce2c7ab4b8f3f1';

function smoke(t, mode = [], { recording = 'true', keys, user = true, cliFails = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'trace-flow-smoke-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const cliDir = path.join(root, 'convex-cli');
  mkdirSync(bin);
  mkdirSync(cliDir);
  const requests = path.join(root, 'requests');
  const calls = path.join(root, 'calls');
  const preload = path.join(root, 'fetch.mjs');
  writeFileSync(requests, '');
  const keyRecords = keys ?? [{ key: registeredKey, expiresAt: Date.now() + 60_000 }];
  writeFileSync(
    path.join(bin, 'bunx'),
    `#!/bin/bash
set -e
test "$PWD" = "$TEST_CLI_DIR"
test -z "\${CONVEX_DEPLOYMENT:-}\${CONVEX_DEPLOY_KEY:-}\${CONVEX_SELF_HOSTED_URL:-}\${CONVEX_SELF_HOSTED_ADMIN_KEY:-}"
printf '%s\\n' "$*" >> "$TEST_CALLS"
if [[ "$TEST_CLI_FAILS" == true ]]; then printf '%s' "$TEST_KEY_RECORDS" >&2; exit 1; fi
case "$*" in
  'convex data users --format jsonl --limit 10000') printf '%s\\n' "$TEST_USER_RECORD" ;;
  'convex run apiKeys:listByOrgId {"orgId":"org_fixture"}') printf '%s\\n' "$TEST_KEY_RECORDS" ;;
  *) exit 98 ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    preload,
    `
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
let expectedAnalyticsKey = '${analyticsKey}';
globalThis.fetch = async (url, init = {}) => {
  const parsed = new URL(url);
  const query = Object.fromEntries(parsed.searchParams);
  const headerKey = init.headers?.['X-Trace-Flow-Api-Key'];
  appendFileSync(process.env.TEST_REQUESTS, JSON.stringify({ path: parsed.pathname, query, method: init.method ?? 'GET', body: init.body, registeredKeyUsed: headerKey === '${registeredKey}' }) + '\\n');
  if (parsed.pathname === '/v1/traces') {
    if (headerKey !== '${registeredKey}') return Response.json({}, { status: 401 });
    return Response.json({}, { headers: { 'X-Trace-Flow-Recording': '${recording}' } });
  }
  if (parsed.pathname === '/v0/sql') {
    if (query.q.includes('FROM otel_trace_spans')) assert.ok(query.q.includes("AND ApiKey = '" + expectedAnalyticsKey + "'"), 'SQL must filter by the hashed analytics key');
    return Response.json({ data: [{ count: 1 }] });
  }
  if (parsed.pathname === '/v0/pipes/mcp_trace_summaries.json') {
    assert.equal(query.api_keys, expectedAnalyticsKey, 'summary must use the hashed analytics key');
    return Response.json({ data: [{}] });
  }
  if (parsed.pathname === '/v0/events') {
    const row = JSON.parse(init.body);
    assert.match(row.ApiKey, /^sha256:[0-9a-f]{64}$/);
    expectedAnalyticsKey = row.ApiKey;
    return Response.json({});
  }
  if (init.method === 'PUT') return Response.json({});
  throw new Error('unexpected endpoint: ' + parsed.pathname);
};
`,
  );
  const result = spawnSync('node', ['--import', preload, script, ...mode], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TEST_REQUESTS: requests,
      TEST_CALLS: calls,
      TEST_CLI_DIR: cliDir,
      TEST_CLI_FAILS: String(cliFails),
      TEST_KEY_RECORDS: JSON.stringify(keyRecords),
      TEST_USER_RECORD: JSON.stringify(
        user ? { email: 'dev@trace-flow.local', orgId: 'org_fixture' } : {},
      ),
      STACK_CONVEX_CLI_DIR: cliDir,
      STACK_EMAIL: 'DEV@trace-flow.local',
      CONVEX_DEPLOYMENT: 'unrelated-cloud-fixture',
      CONVEX_DEPLOY_KEY: 'unrelated-fixture',
      CONVEX_SELF_HOSTED_URL: 'https://unrelated.example',
      CONVEX_SELF_HOSTED_ADMIN_KEY: 'unrelated-fixture',
      TRACE_FLOW_TINYBIRD_HOST: 'http://127.0.0.1:7181',
      TINYBIRD_WORKSPACE_TOKEN: 'fixture-token',
      STACK_PROXY_URL: 'http://127.0.0.1:8787',
      STACK_KV_BRIDGE_URL: 'http://127.0.0.1:8791',
      KV_BRIDGE_TOKEN: 'fixture-bridge',
      STACK_API_KEYS_KV_ID: 'fixture-namespace',
      TRACE_FLOW_SMOKE_TIMEOUT_MS: '0',
    },
    encoding: 'utf8',
  });
  const output = result.stdout + result.stderr;
  assert.ok(!output.includes(registeredKey), 'credentials must not appear in output');
  return {
    result,
    requests: readFileSync(requests, 'utf8').split('\n').filter(Boolean).map(JSON.parse),
    calls: (() => {
      try {
        return readFileSync(calls, 'utf8');
      } catch {
        return '';
      }
    })(),
  };
}

test('runtime smoke obtains a Convex-registered key and queries its sha256 analytics ID', (t) => {
  const { result, requests, calls } = smoke(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(calls, /convex data users/);
  assert.match(calls, /convex run apiKeys:listByOrgId/);
  assert.ok(requests.some((request) => request.path === '/v1/traces' && request.registeredKeyUsed));
  assert.ok(
    requests.some((request) => request.query.q?.includes(`AND ApiKey = '${analyticsKey}'`)),
  );
  assert.ok(requests.some((request) => request.query.api_keys === analyticsKey));
  assert.ok(requests.every((request) => request.method !== 'PUT'));
});

test('runtime smoke fails when the proxy accepts but does not record the trace', (t) => {
  const { result } = smoke(t, [], { recording: 'false' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /did not record/);
});

for (const [name, options, message] of [
  ['missing organization', { user: false }, /sign in first/],
  ['no keys', { keys: [] }, /finish onboarding/],
  ['expired key', { keys: [{ key: registeredKey, expiresAt: 1 }] }, /unexpired ingest/],
  [
    'read-only key',
    { keys: [{ key: registeredKey, expiresAt: Date.now() + 60_000, permissions: ['mcp:read'] }] },
    /unexpired ingest/,
  ],
  ['CLI failure', { cliFails: true }, /local Convex command failed/],
]) {
  test(`runtime smoke rejects ${name} without posting or exposing keys`, (t) => {
    const { result, requests } = smoke(t, [], options);
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
    assert.ok(requests.every((request) => request.path !== '/v1/traces'));
  });
}

test('Tinybird-only smoke inserts and queries hashed IDs without Convex or Workers', (t) => {
  const { result, requests, calls } = smoke(t, ['--tinybird-only']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls, '');
  assert.ok(requests.some((request) => request.path === '/v0/events'));
  assert.ok(requests.every((request) => request.path.startsWith('/v0/')));
});
