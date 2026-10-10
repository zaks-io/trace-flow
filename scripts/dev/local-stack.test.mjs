import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
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

test('doctor reports missing sha256sum before any runtime allocation', (t) => {
  const { scripts, bin, env, root, calls } = fixture(t);
  symlinkSync('/usr/bin/dirname', path.join(bin, 'dirname'));
  const result = spawnSync('/bin/bash', [path.join(scripts, 'local-stack.sh'), 'doctor'], {
    env: { ...env, HOME: root, PATH: bin, TRACE_FLOW_TINYBIRD_HOST: 'https://unrelated.example' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /miss sha256sum/);
  assert.match(result.stdout, /miss docker daemon/);
  assert.ok(!readFileSync(calls, 'utf8').includes('sbx-runtime'));
  assert.equal(existsSync(path.join(root, '.trace-flow')), false);
});

test('Tinybird host overrides block data commands but leave diagnostics and shutdown usable', (t) => {
  const { scripts, bin, env, root } = fixture(t);
  writeFileSync(
    path.join(bin, 'sbx-runtime'),
    `#!/bin/bash
printf 'SBX_WORKTREE_ID=fixture\\nSBX_STATE_DIR=${root}/state\\n'
for service in "\${@:6}"; do
  key="SBX_PORT_\${service^^}"; key="\${key//-/_}"
  printf '%s=17000\\n' "$key"
done
`,
    { mode: 0o755 },
  );
  writeFileSync(path.join(bin, 'docker'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(path.join(bin, 'curl'), '#!/bin/bash\nexit 99\n', { mode: 0o755 });
  const commandEnv = { ...env, TRACE_FLOW_TINYBIRD_HOST: 'https://unrelated.example' };
  for (const command of ['up', 'smoke', 'verify', 'seed']) {
    const result = spawnSync('bash', [path.join(scripts, 'local-stack.sh'), command], {
      env: commandEnv,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /set TRACE_FLOW_LOCAL_STACK_TINYBIRD_PORT/);
  }
  for (const command of ['down', 'status', 'doctor']) {
    const result = spawnSync('bash', [path.join(scripts, 'local-stack.sh'), command], {
      env: commandEnv,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('Tinybird token files are private without changing the caller umask', (t) => {
  const { scripts, bin, env, root } = fixture(t);
  writeFileSync(
    path.join(bin, 'tb'),
    `#!/bin/bash
printf '{"user_token":"fixture-user","workspace_token":"fixture-workspace"}'
`,
    { mode: 0o755 },
  );
  const result = bash(
    `
source '${scripts}/_common.sh'
source '${scripts}/_tinybird.sh'
STACK_TINYBIRD_ENV='${root}/tinybird.env'
unset TB_LOCAL_USER_TOKEN TB_LOCAL_WORKSPACE_TOKEN
umask 022
ensure_tinybird_tokens
test "$(umask)" = 0022
test "$TB_LOCAL_WORKSPACE_TOKEN" = fixture-workspace
test "$(stat -c %a "$STACK_TINYBIRD_ENV")" = 600
`,
    env,
  );
  assert.equal(result.status, 0, result.stderr);
});

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

test('Local Workers load an existing dev.env and the optional Wrangler env file', (t) => {
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

for (const command of ['deploy --wait --auto', 'build', 'test run']) {
  test(`Tinybird ${command} uses its private workspace without changing the cloud selection`, (t) => {
    const { scripts, bin, env, root } = fixture(t);
    const original = JSON.stringify({ name: 'cloud-workspace-fixture' });
    writeFileSync(path.join(root, '.tinyb'), original);
    const configFile = path.join(root, 'used-config');
    writeFileSync(
      path.join(bin, 'tb'),
      `#!/bin/bash
set -e
test "$*" = '--local ${command}'
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
tinybird_cli ${command}
`,
      { ...env, TEST_CONFIG: configFile },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(configFile, 'utf8')), {
      name: command.startsWith('deploy')
        ? 'Tinybird_Local_Testing'
        : 'Trace_Flow_Local_Verification',
      cwd: root,
    });
    assert.equal(readFileSync(path.join(root, '.tinyb'), 'utf8'), original);
  });
}
