import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configureProxyTinybirdToken } from './configure-proxy-tinybird-token.mjs';

const name = 'trace_flow_proxy_spans_append';
const token = {
  name,
  scopes: [{ type: 'DATASOURCES:APPEND', resource: 'otel_trace_spans' }],
  token: 'dummy-scoped-token',
};
let directory;
let previousHost;
let previousToken;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'preview-proxy-token-'));
  previousHost = process.env.TB_HOST;
  previousToken = process.env.TB_TOKEN;
  process.env.TB_HOST = 'https://tinybird.test';
  process.env.TB_TOKEN = 'dummy-admin-token';
});

afterEach(async () => {
  for (const [key, value] of [
    ['TB_HOST', previousHost],
    ['TB_TOKEN', previousToken],
  ]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  mock.restoreAll();
  await rm(directory, { recursive: true });
});

test('exports the deployment-managed append token with private file permissions', async () => {
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer dummy-admin-token');
    calls.push({ path: url.pathname, method: init.method ?? 'GET' });
    return Response.json({ tokens: [token] });
  });
  const path = join(directory, 'consumer.env');
  await writeFile(path, '', { mode: 0o644 });
  await configureProxyTinybirdToken(path);
  assert.equal(await readFile(path, 'utf8'), 'TINYBIRD_TOKEN=dummy-scoped-token\n');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(calls, [{ path: '/v0/tokens', method: 'GET' }]);
});

test('fails on an undeployed token without attempting an API mutation', async () => {
  const fetch = mock.method(globalThis, 'fetch', async () => Response.json({ tokens: [] }));
  const path = join(directory, 'consumer.env');
  await assert.rejects(configureProxyTinybirdToken(path), /Deploy the .* datafile token first/);
  assert.equal(fetch.mock.callCount(), 1);
  await assert.rejects(stat(path), { code: 'ENOENT' });
});

for (const invalid of [
  { ...token, scopes: [{ type: 'ADMIN' }] },
  { ...token, scopes: [{ type: 'DATASOURCES:APPEND', resource: 'other' }] },
  { ...token, token: 'dummy\ninjected=secret' },
  { ...token, token: '' },
  { ...token, token: 123 },
]) {
  test('rejects invalid token scopes or serialization without writing a file', async () => {
    mock.method(globalThis, 'fetch', async () => Response.json({ tokens: [invalid] }));
    const path = join(directory, 'consumer.env');
    await assert.rejects(configureProxyTinybirdToken(path), /invalid scopes or value/);
    await assert.rejects(stat(path), { code: 'ENOENT' });
  });
}

for (const listing of [{}, { tokens: [token, token] }]) {
  test('rejects an absent or ambiguous token inventory', async () => {
    mock.method(globalThis, 'fetch', async () => Response.json(listing));
    await assert.rejects(
      configureProxyTinybirdToken(join(directory, 'consumer.env')),
      /no token inventory|duplicate trace append tokens/,
    );
  });
}

test('fails closed on a token inventory HTTP failure', async () => {
  mock.method(globalThis, 'fetch', async () => new Response('', { status: 403 }));
  const path = join(directory, 'consumer.env');
  await assert.rejects(configureProxyTinybirdToken(path), /HTTP 403/);
  await assert.rejects(stat(path), { code: 'ENOENT' });
});

test('requires credentials before a request', async () => {
  delete process.env.TB_TOKEN;
  const fetch = mock.method(globalThis, 'fetch', async () => {
    throw new Error('unexpected fetch');
  });
  await assert.rejects(configureProxyTinybirdToken(join(directory, 'consumer.env')), /required/);
  assert.equal(fetch.mock.callCount(), 0);
});
