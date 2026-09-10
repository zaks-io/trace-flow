import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireExecutor, executorIdentity, readLockHandshake } from './agent-executor';

test('lock handshake accepts fragmented stdout and rejects incomplete or invalid responses', async () => {
  const stream = (chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
  expect(await readLockHandshake(stream(['lo', 'ck', 'ed', '\n']))).toBe(true);
  expect(await readLockHandshake(stream(['locked']))).toBe(false);
  expect(await readLockHandshake(stream(['invalid\n']))).toBe(false);
});

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

test('a signal-killed holder is recognized as a lost lock', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-executor-signal-test-'));
  const originalSpawn = Bun.spawn;
  let child: { pid: number; exited: Promise<number> } | undefined;
  const spawn = spyOn(Bun, 'spawn').mockImplementation((...args) => {
    const result = Reflect.apply(originalSpawn, Bun, args);
    child = result;
    return result;
  });
  let holder: Awaited<ReturnType<typeof acquireExecutor>> | undefined;
  try {
    holder = await acquireExecutor('http://localhost:7181', crypto.randomUUID(), directory);
    holder.assertHeld();
    process.kill(child!.pid, 'SIGKILL');
    await child!.exited;
    expect(holder.assertHeld).toThrow('lock was lost');
  } finally {
    spawn.mockRestore();
    await holder?.release();
  }
});
