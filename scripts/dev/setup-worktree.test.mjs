import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const setup = path.join(repo, 'setup-worktree.sh');
const prepare = path.join(repo, 'scripts/dev/prepare-hooks.mjs');

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function fixture(t, install) {
  const root = mkdtempSync(path.join(tmpdir(), 'trace-flow-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, 'main');
  const worktree = path.join(root, 'worktree');
  const bin = path.join(root, 'bin');
  mkdirSync(main);
  mkdirSync(bin);
  git(main, 'init', '-q');
  git(
    main,
    '-c',
    'user.name=Setup Test',
    '-c',
    'user.email=setup@example.test',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture',
  );
  git(main, 'worktree', 'add', '--detach', worktree);
  writeFileSync(path.join(main, '.env.local'), 'fixture-main\n');
  writeFileSync(path.join(bin, 'bun'), `#!/bin/bash\nset -e\n${install}\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_ROOT: root };
  delete env.HUSKY;
  return { root, main, worktree, env };
}

function run(cwd, env, command = 'bash', args = [setup]) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

for (const sameWorktree of [true, false]) {
  test(`serializes installs ${sameWorktree ? 'within' : 'across'} worktrees`, async (t) => {
    const { root, main, worktree, env } = fixture(
      t,
      `
test "$*" = "install --frozen-lockfile"
mkdir "$FIXTURE_ROOT/install-active"
trap 'rmdir "$FIXTURE_ROOT/install-active"' EXIT
printf 'start\\n' >> "$FIXTURE_ROOT/events"
sleep 0.3
printf 'end\\n' >> "$FIXTURE_ROOT/events"`,
    );
    const results = await Promise.all([
      run(worktree, env),
      run(sameWorktree ? worktree : main, env),
    ]);
    for (const result of results) assert.equal(result.code, 0, result.output);
    assert.equal(readFileSync(path.join(root, 'events'), 'utf8'), 'start\nend\nstart\nend\n');
    assert.equal(readFileSync(path.join(worktree, '.env.local'), 'utf8'), 'fixture-main\n');
  });
}

test('preserves existing worktree environment files', async (t) => {
  const { worktree, env } = fixture(t, 'exit 0');
  writeFileSync(path.join(worktree, '.env.local'), 'fixture-worktree\n');
  const result = await run(worktree, env);
  assert.equal(result.code, 0, result.output);
  assert.equal(readFileSync(path.join(worktree, '.env.local'), 'utf8'), 'fixture-worktree\n');
});

test('failed installs stop setup and release the lock for the next run', async (t) => {
  const { root, worktree, env } = fixture(t, 'exit 42');
  const failed = await run(worktree, env);
  assert.equal(failed.code, 42, failed.output);
  assert.doesNotMatch(failed.output, /setup complete|copied/);
  writeFileSync(path.join(root, 'bin/bun'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  const retry = await run(worktree, env);
  assert.equal(retry.code, 0, retry.output);
});

test('Husky config-lock errors fail setup even with existing hooks', async (t) => {
  const { main, worktree, env } = fixture(t, 'node "$PREPARE_SCRIPT"');
  env.PREPARE_SCRIPT = prepare;
  const initial = await run(worktree, env);
  assert.equal(initial.code, 0, initial.output);
  assert.match(readFileSync(path.join(worktree, '.husky/_/pre-commit'), 'utf8'), /h/);
  writeFileSync(path.join(main, '.git/config.lock'), '');
  const failed = await run(worktree, env);
  assert.equal(failed.code, 1, failed.output);
  assert.match(failed.output, /could not lock config file/);
  assert.doesNotMatch(failed.output, /setup complete/);
});
