import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SnapshotTinybird from '../snapshot-tinybird';
import { snapshotCopyPlans } from '../snapshot-runner';
import {
  publishSnapshotManifest,
  snapshotJobStatus,
  startSnapshotCopy,
} from '../snapshot-tinybird';
import { makeSnapshotRunner } from './snapshot-runner-fixture';

vi.mock('../snapshot-tinybird', async (importOriginal) => ({
  ...(await importOriginal<typeof SnapshotTinybird>()),
  publishSnapshotManifest: vi.fn(),
  snapshotJobStatus: vi.fn(),
  startSnapshotCopy: vi.fn(),
}));

describe('oversized durable snapshot runner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2028-03-01T12:00:00Z'));
    vi.mocked(startSnapshotCopy)
      .mockReset()
      .mockImplementation(
        async (_env, target, copy) => `job-${target.replaceAll('_', '-')}-${copy.copyAttempt}`,
      );
    vi.mocked(snapshotJobStatus).mockReset().mockResolvedValue('done');
    vi.mocked(publishSnapshotManifest).mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  it(
    'resumes 108 serial Copies across queue invocations and publishes one linked generation',
    { timeout: 30_000 },
    async () => {
      const dirtyDays = retainedDays(367);
      const f = await makeSnapshotRunner(dirtyDays);
      expect(await f.finish()).toMatchObject({ status: 'complete', capturedDays: 367 });
      const copies = vi.mocked(startSnapshotCopy).mock.calls.map((call) => call[2]);
      expect(copies).toHaveLength(108);
      expect(copies.every((copy) => copy.dirtyDays.length <= 31)).toBe(true);
      expect(new Set(copies.map((copy) => copy.copyAttempt)).size).toBe(12);
      expect(publishSnapshotManifest).toHaveBeenCalledOnce();
      expect(await f.coordinator.getStats({})).toMatchObject({ gatePhase: 'open', dirtyDays: 0 });
    },
  );

  it('retains an oversized generation and its receipt while a job is running', async () => {
    vi.mocked(snapshotJobStatus).mockResolvedValue('working');
    const f = await makeSnapshotRunner(retainedDays(32));
    await f.wake();
    expect(await f.wake()).toMatchObject({ status: 'continued', nextCopyIndex: 0 });
    expect(await f.coordinator.getOutstandingSnapshotCopyIntents({})).toHaveLength(1);
    expect(snapshotJobStatus).toHaveBeenCalledOnce();
    expect(publishSnapshotManifest).not.toHaveBeenCalled();
  });

  it('rejects a CopyAttempt that exceeds safe integers before starting work', () => {
    expect(() =>
      snapshotCopyPlans({
        orgId: 'org-1',
        generation: Math.floor(Number.MAX_SAFE_INTEGER / 16) + 1,
        dirtyDays: retainedDays(32),
      }),
    ).toThrow('CopyAttempt exceeds the safe integer range');
  });
});

function retainedDays(count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    new Date(Date.UTC(2028, 2, 1) - index * 86_400_000).toISOString().slice(0, 10),
  ).sort();
}
