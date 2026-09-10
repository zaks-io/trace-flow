import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireExecutor, executorIdentity } from './agent-executor';

test('one executor owns an organization and backup until its OS lock releases', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-executor-test-'));
  const org = crypto.randomUUID();
  const first = await acquireExecutor('http://localhost:7181', org, directory);
  try {
    first.assertHeld();
    expect(executorIdentity(directory)).toBe(executorIdentity(directory));
    await expect(
      acquireExecutor('http://localhost:7181', org, join(directory, 'other')),
    ).rejects.toThrow('Another repair executor');
    await expect(
      acquireExecutor('http://localhost:7181', crypto.randomUUID(), directory),
    ).rejects.toThrow('Another repair executor');
  } finally {
    await first.release();
  }
  expect(first.assertHeld).toThrow('lock was lost');
  const resumed = await acquireExecutor('http://localhost:7181', org, directory);
  resumed.assertHeld();
  await resumed.release();
});
