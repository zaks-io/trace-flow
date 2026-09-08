import assert from 'node:assert/strict';
import { describe, test } from 'bun:test';
import {
  captureCommand,
  formatProcessFailure,
  sanitizeProcessOutput,
} from './archive-api-process-diagnostics';

describe('archive deployment diagnostics', () => {
  test('keeps complete stdout, stderr, and exit code while removing sensitive values', () => {
    const prefix = 'x'.repeat(12_000);
    const suffix = 'y'.repeat(12_000);
    const secret = 'shared-secret-value';
    const credential = 'collector-credential-value';
    const output = formatProcessFailure(
      'Convex command',
      {
        exitCode: 17,
        stdout: `${prefix}\nsecret=${secret}\n${suffix}`,
        stderr: `collectorCredentialId='${credential}'`,
      },
      [secret, credential],
    );

    assert.match(output, /exit code 17/u);
    assert.ok(output.includes(prefix));
    assert.ok(output.includes(suffix));
    assert.ok(!output.includes(secret));
    assert.ok(!output.includes(credential));
    assert.match(output, /\[REDACTED\]/u);
  });

  test('redacts bearer tokens and named secret assignments', () => {
    const output = sanitizeProcessOutput(
      'Authorization: Bearer abc123\nARCHIVE_KEY_WRAPPING_SECRET=value',
    );
    assert.equal(
      output,
      'Authorization: Bearer [REDACTED]\nARCHIVE_KEY_WRAPPING_SECRET=[REDACTED]',
    );
  });

  test('discards an object body while preserving complete failure diagnostics', async () => {
    const objectBody = 'synthetic-ciphertext-sentinel';
    const stderr = `wrangler diagnostic ${'z'.repeat(12_000)}`;
    const result = await captureCommand(
      process.execPath,
      [
        '-e',
        `process.stdout.write(${JSON.stringify(objectBody)}); process.stderr.write(${JSON.stringify(stderr)});`,
      ],
      { cwd: import.meta.dirname, captureStdout: false },
    );
    const output = formatProcessFailure('Wrangler archive cleanup', result);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, stderr);
    assert.match(output, /exit code 0/u);
    assert.ok(output.includes(stderr));
    assert.ok(!output.includes(objectBody));
  });
});
