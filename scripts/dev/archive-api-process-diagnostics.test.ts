import assert from 'node:assert/strict';
import { describe, test } from 'bun:test';
import { formatProcessFailure, sanitizeProcessOutput } from './archive-api-process-diagnostics';

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
});
