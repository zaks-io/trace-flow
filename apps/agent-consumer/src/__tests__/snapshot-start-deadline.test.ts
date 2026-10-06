import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SnapshotTinybird from '../snapshot-tinybird';
import { startSnapshotCopy, discoverSnapshotCopy } from '../snapshot-tinybird';
import { AGENT_SNAPSHOT_WORK_DEADLINE_MS } from '../snapshot-runner-support';
import { makeSnapshotRunner } from './snapshot-runner-fixture';

vi.mock('../snapshot-tinybird', async (importOriginal) => ({
  ...(await importOriginal<typeof SnapshotTinybird>()),
  publishSnapshotManifest: vi.fn(),
  discoverSnapshotCopy: vi.fn(async () => null),
  snapshotJobStatus: vi.fn(async () => 'done'),
  startSnapshotCopy: vi.fn(),
}));

describe('snapshot Copy start deadlines', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
    vi.mocked(startSnapshotCopy)
      .mockReset()
      .mockImplementation(async (_env, target) => `job-${target.replaceAll('_', '-')}`);
    vi.mocked(discoverSnapshotCopy).mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it.each(['assertSnapshotActive', 'recordSnapshotCopyIntent'] as const)(
    'does not strand an unsubmitted intent when %s crosses the work deadline',
    async (delayedMethod) => {
      const f = await makeSnapshotRunner();
      let delayed = false;
      const coordinator = new Proxy(f.coordinator, {
        get(target, name) {
          if (name === delayedMethod)
            return async (...args: Parameters<(typeof target)[typeof delayedMethod]>) => {
              const method = target[delayedMethod] as (...input: typeof args) => Promise<unknown>;
              const result = await method(...args);
              if (!delayed) {
                delayed = true;
                vi.setSystemTime(Date.now() + AGENT_SNAPSHOT_WORK_DEADLINE_MS);
              }
              return result;
            };
          return Reflect.get(target, name);
        },
      });
      f.env.AGENT_DELIVERY_COORDINATOR = {
        getByName: () => coordinator,
      } as unknown as typeof f.env.AGENT_DELIVERY_COORDINATOR;
      expect(await f.wake()).toMatchObject({ status: 'continued', generation: 1 });
      if (delayedMethod === 'assertSnapshotActive') {
        expect(startSnapshotCopy).not.toHaveBeenCalled();
        expect(await f.coordinator.getOutstandingSnapshotCopyIntents({})).toEqual([]);
      } else {
        expect(startSnapshotCopy).toHaveBeenCalledOnce();
        expect(await f.coordinator.getOutstandingSnapshotCopyIntents({})).toEqual([
          expect.objectContaining({ jobId: expect.any(String) }),
        ]);
      }
      expect(await f.finish()).toMatchObject({ status: 'complete', generation: 1 });
      expect(startSnapshotCopy).toHaveBeenCalledTimes(9);
      expect(discoverSnapshotCopy).not.toHaveBeenCalled();
    },
  );
});
