import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const devDir = fileURLToPath(new URL('./', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'trace-flow-stack-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = path.join(root, 'scripts/dev');
  cpSync(devDir, scripts, { recursive: true });
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const calls = path.join(root, 'calls');
  for (const tool of ['sbx-runtime', 'docker', 'tb', 'bun', 'tailscale']) {
    writeFileSync(
      path.join(bin, tool),
      `#!/bin/bash\nprintf '%s\\n' '${tool}' >> "$TEST_CALLS"\nexit 99\n`,
      { mode: 0o755 },
    );
  }
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_CALLS: calls };
  delete env.SBX_WORKTREE_ID;
  delete env.TRACE_FLOW_STATE_DIR;
  delete env.TRACE_FLOW_LOCAL_STACK_DIR;
  return { root, scripts, bin, calls, env };
}

function bash(script, env) {
  return spawnSync('bash', ['-c', script], { env, encoding: 'utf8' });
}

for (const argument of ['--help', 'help', 'unknown-command']) {
  test(`${argument} never discovers tools, allocates runtime, or starts services`, (t) => {
    const { scripts, calls, env, root } = fixture(t);
    const result = spawnSync('bash', [path.join(scripts, 'local-stack.sh'), argument], {
      env,
      encoding: 'utf8',
    });
    assert.equal(result.status, argument === 'unknown-command' ? 1 : 0, result.stderr);
    assert.equal(existsSync(calls), false);
    assert.equal(existsSync(path.join(root, '.trace-flow')), false);
  });
}

test('standalone runtime uses private resource names, local state and explicit ports without sbx-runtime', (t) => {
  const { scripts, env, calls, root } = fixture(t);
  const result = bash(
    `
source '${scripts}/_common.sh'
command_exists() { [[ "$1" != sbx-runtime ]] && command -v "$1" >/dev/null; }
source '${scripts}/_runtime.sh'
printf '%s\\n' "$TRACE_FLOW_STATE_DIR" "$TRACE_FLOW_TINYBIRD_HOST" "$TB_LOCAL_CLICKHOUSE_INTERFACE_PORT" "$TRACE_FLOW_TINYBIRD_CONTAINER"
`,
    {
      ...env,
      TRACE_FLOW_LOCAL_STACK_TINYBIRD_PORT: '17181',
      TRACE_FLOW_LOCAL_STACK_TINYBIRD_CLICKHOUSE_PORT: '17182',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const [state, host, clickhouse, container] = result.stdout.trim().split('\n');
  assert.equal(state, path.join(root, '.trace-flow'));
  assert.equal(host, 'http://127.0.0.1:17181');
  assert.equal(clickhouse, '17182');
  assert.match(container, /^trace-flow-tinybird-[0-9a-f]{12}$/);
  assert.equal(existsSync(calls), false);
});

test('sandbox runtime uses allocated ports and private state', (t) => {
  const { scripts, bin, env, root } = fixture(t);
  writeFileSync(
    path.join(bin, 'sbx-runtime'),
    `#!/bin/bash
printf 'SBX_WORKTREE_ID=fixture\\nSBX_STATE_DIR=${root}/state\\n'
for service in "\${@:6}"; do
  key="SBX_PORT_\${service^^}"
  key="\${key//-/_}"
  printf '%s=17000\\n' "$key"
done
`,
    { mode: 0o755 },
  );
  const result = bash(
    `source '${scripts}/_common.sh'; source '${scripts}/_runtime.sh'; printf '%s\\n' "$TRACE_FLOW_STATE_DIR" "$TRACE_FLOW_TINYBIRD_HOST" "$TRACE_FLOW_LOCAL_STACK_WEB_PORT" "$TRACE_FLOW_TINYBIRD_CONTAINER"`,
    env,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    path.join(root, 'state/trace-flow'),
    'http://127.0.0.1:17000',
    '17000',
    'trace-flow-tinybird-fixture',
  ]);
});

test('smoke and verification refuse unprepared stacks without starting services', (t) => {
  const { scripts, env, calls, root } = fixture(t);
  for (const command of ['cmd_smoke', 'cmd_verify quick']) {
    const result = bash(
      `
source '${scripts}/_common.sh'
STACK_DIR='${root}/missing'
STACK_SECRETS="$STACK_DIR/secrets.env"
source '${scripts}/_tinybird.sh'
source '${scripts}/local-stack-checks.sh'
${command}
`,
      env,
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /local stack is not prepared/);
  }
  assert.equal(existsSync(calls), false);
});

function smoke(t, mode, recording = 'true') {
  const { root, env } = fixture(t);
  const requests = path.join(root, 'requests');
  const preload = path.join(root, 'fetch.mjs');
  writeFileSync(
    preload,
    `
import { appendFileSync } from 'node:fs';
globalThis.fetch = async (url, init = {}) => {
  const parsed = new URL(url);
  appendFileSync(process.env.TEST_REQUESTS, JSON.stringify({ path: parsed.pathname, method: init.method ?? 'GET', body: init.body }) + '\\n');
  if (parsed.pathname === '/v1/traces') return Response.json({}, { headers: { 'X-Trace-Flow-Recording': '${recording}' } });
  if (parsed.pathname === '/v0/sql') return Response.json({ data: [{ count: 1 }] });
  if (parsed.pathname.includes('/v0/pipes/')) return Response.json({ data: [{}] });
  return Response.json({});
};
`,
  );
  const result = spawnSync(
    'node',
    ['--import', preload, path.join(devDir, 'local-stack-smoke.mjs'), ...mode],
    {
      env: {
        ...env,
        TEST_REQUESTS: requests,
        TRACE_FLOW_TINYBIRD_HOST: 'http://127.0.0.1:7181',
        TINYBIRD_WORKSPACE_TOKEN: 'fixture-token',
        STACK_PROXY_URL: 'http://127.0.0.1:8787',
        STACK_KV_BRIDGE_URL: 'http://127.0.0.1:8791',
        KV_BRIDGE_TOKEN: 'fixture-bridge',
        STACK_API_KEYS_KV_ID: 'fixture-namespace',
      },
      encoding: 'utf8',
    },
  );
  return { result, requests: readFileSync(requests, 'utf8').trim().split('\n').map(JSON.parse) };
}

test('runtime smoke writes the shared KV bridge, posts OTLP and verifies the summary', (t) => {
  const { result, requests } = smoke(t, []);
  assert.equal(result.status, 0, result.stderr);
  const writes = requests.filter((request) => request.method === 'PUT');
  assert.equal(writes.length, 2);
  assert.ok(
    writes.every((request) => request.path.includes('/namespaces/fixture-namespace/values/')),
  );
  assert.ok(requests.some((request) => request.path === '/v1/traces' && request.method === 'POST'));
  assert.ok(requests.some((request) => request.path === '/v0/pipes/mcp_trace_summaries.json'));
});

test('runtime smoke fails when the proxy accepts but does not record the trace', (t) => {
  const { result } = smoke(t, [], 'false');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /did not record/);
});

test('Tinybird-only smoke inserts and queries without touching Workers', (t) => {
  const { result, requests } = smoke(t, ['--tinybird-only']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(requests.some((request) => request.path === '/v0/events'));
  assert.ok(requests.every((request) => request.path.startsWith('/v0/')));
});

test('Local Workers retain generated env loading and the optional Wrangler env file', (t) => {
  const { scripts, bin, env, root } = fixture(t);
  const state = path.join(root, 'state');
  mkdirSync(state);
  writeFileSync(path.join(state, 'dev.env'), 'WORKERS_FIXTURE_VALUE=loaded\n');
  const argsFile = path.join(root, 'worker-args');
  writeFileSync(
    path.join(bin, 'bunx'),
    `#!/bin/bash
printf '%s\\n' "$@" > "$TEST_ARGS"
test "$WORKERS_FIXTURE_VALUE" = loaded
`,
    { mode: 0o755 },
  );
  const result = spawnSync('bash', [path.join(scripts, 'workers.sh')], {
    env: {
      ...env,
      TRACE_FLOW_STATE_DIR: state,
      TRACE_FLOW_WORKERS_ENV_FILE: 'custom.env',
      TEST_ARGS: argsFile,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const args = readFileSync(argsFile, 'utf8').trim().split('\n');
  assert.equal(args[0], 'wrangler');
  assert.equal(args[1], 'dev');
  assert.deepEqual(args.slice(-4), ['--persist-to', '.wrangler/state', '--env-file', 'custom.env']);
  assert.equal(args.filter((arg) => arg === '-c').length, 6);
});

test('Tinybird CLI pins a private workspace without changing the checkout cloud selection', (t) => {
  const { scripts, bin, env, root } = fixture(t);
  const original = JSON.stringify({ name: 'cloud-workspace-fixture' });
  writeFileSync(path.join(root, '.tinyb'), original);
  const configFile = path.join(root, 'used-config');
  writeFileSync(
    path.join(bin, 'tb'),
    `#!/bin/bash
set -e
test "$*" = '--local deploy --wait --auto'
test "$TB_HOST" = http://127.0.0.1:17181
test "$TB_TOKEN" = fixture-token
cp .tinyb "$TEST_CONFIG"
`,
    { mode: 0o755 },
  );
  const result = bash(
    `
source '${scripts}/_common.sh'
source '${scripts}/_tinybird.sh'
STACK_DIR='${root}/stack'
TINYBIRD_WORKSPACE_TOKEN=fixture-token
TRACE_FLOW_TINYBIRD_HOST=http://127.0.0.1:17181
tinybird_cli deploy --wait --auto
`,
    { ...env, TEST_CONFIG: configFile },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(configFile, 'utf8')), {
    name: 'Tinybird_Local_Testing',
    cwd: root,
  });
  assert.equal(readFileSync(path.join(root, '.tinyb'), 'utf8'), original);
});
