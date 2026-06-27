/// <reference types="node" />
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPiRunnerScript } from '../piRunner';

// The runner is emitted as a string template (String.raw) and only parsed when the sandbox
// executes it, so a malformed edit inside the template is invisible to the host type-check.
// This guards the one thing that matters: the generated script is valid, parseable ESM.
describe('buildPiRunnerScript', () => {
  it('produces syntactically valid JavaScript', () => {
    const script = buildPiRunnerScript();
    const dir = mkdtempSync(join(tmpdir(), 'pi-runner-'));
    const file = join(dir, 'runner.mjs');
    writeFileSync(file, script);

    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
