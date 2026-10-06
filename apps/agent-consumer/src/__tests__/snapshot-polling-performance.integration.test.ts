import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SnapshotTinybird from '../snapshot-tinybird';
import {
  discoverSnapshotCopy,
  publishSnapshotManifest,
  snapshotJobStatus,
  startSnapshotCopy,
} from '../snapshot-tinybird';
import { makeSnapshotRunner } from './snapshot-runner-fixture';

vi.mock('../snapshot-tinybird', async (importOriginal) => ({
  ...(await importOriginal<typeof SnapshotTinybird>()),
  discoverSnapshotCopy: vi.fn(),
  publishSnapshotManifest: vi.fn(),
  snapshotJobStatus: vi.fn(),
  startSnapshotCopy: vi.fn(),
}));

const START = new Date('2026-10-01T12:00:00Z').getTime();

describe('snapshot polling waiting budget in workerd', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    { days: 1, copies: 9 },
    { days: 7, copies: 9 },
    { days: 32, copies: 18 },
  ])(
    'reduces first-check waiting for $days linked dates without extra reads',
    async ({ days, copies }) => {
      const before = await measureGeneration(days, 2_000, true);
      const after = await measureGeneration(days, 2_000, false);
      expect(before).toEqual({ gateDurationMs: copies * 15_000, statusReads: copies });
      expect(after).toEqual({ gateDurationMs: copies * 5_000, statusReads: copies });
    },
  );

  it('keeps the old waiting budget for Copies that finish between five and 15 seconds', async () => {
    const before = await measureGeneration(1, 7_000, true);
    const after = await measureGeneration(1, 7_000, false);
    expect(before).toEqual({ gateDurationMs: 135_000, statusReads: 9 });
    expect(after).toEqual({ gateDurationMs: 135_000, statusReads: 18 });
  });

  async function measureGeneration(days: number, copyRuntimeMs: number, legacyCadence: boolean) {
    vi.setSystemTime(START);
    const jobs = new Map<string, { startedAtMs: number; finished: boolean }>();
    vi.mocked(startSnapshotCopy)
      .mockReset()
      .mockImplementation(async (_env, target, plan) => {
        expect([...jobs.values()].every((job) => job.finished)).toBe(true);
        const jobId = `${target.replaceAll('_', '-')}-${plan.copyAttempt}`;
        jobs.set(jobId, { startedAtMs: Date.now(), finished: false });
        return jobId;
      });
    vi.mocked(snapshotJobStatus)
      .mockReset()
      .mockImplementation(async (_env, jobId) => {
        const job = jobs.get(jobId);
        if (!job) throw new Error('Status read has no submitted Copy');
        job.finished = Date.now() - job.startedAtMs >= copyRuntimeMs;
        return job.finished ? 'done' : 'working';
      });
    vi.mocked(publishSnapshotManifest)
      .mockReset()
      .mockImplementation(async () => {
        expect([...jobs.values()].every((job) => job.finished)).toBe(true);
      });
    vi.mocked(discoverSnapshotCopy).mockReset().mockResolvedValue(null);
    const dirtyDays = Array.from({ length: days }, (_, index) =>
      new Date(START - index * 86_400_000).toISOString().slice(0, 10),
    ).sort();
    const f = await makeSnapshotRunner(dirtyDays);
    await f.coordinator.scheduleSnapshot({ orgId: f.orgId });
    let result = await f.wake();
    const gateStartedAtMs = Date.now();
    await expect(
      f.coordinator.reserve({
        deliveryId: 'while-snapshot-running',
        payloadSha256: 'b'.repeat(64),
        dirtyDays: [dirtyDays[0]!],
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
      }),
    ).resolves.toBeNull();
    for (let iteration = 0; result.status === 'continued' && iteration < 100; iteration += 1) {
      expect(await f.coordinator.getStats({})).toMatchObject({ gatePhase: 'snapshot' });
      expect(await f.coordinator.getOutstandingSnapshotCopyIntents({})).toHaveLength(1);
      if (legacyCadence) {
        // Recreate the former durable schedule without replacing the runner or SQLite storage.
        await f.withStorage((storage) => {
          storage.sql.exec(
            `UPDATE snapshot_checks SET next_check_at_ms = ? +
             CASE WHEN status_checks = 0 THEN 15000
                  WHEN status_checks = 1 THEN 30000 ELSE 60000 END
             WHERE singleton = 1`,
            Date.now(),
          );
        });
      }
      result = await f.wake();
    }
    expect(result).toMatchObject({ status: 'complete', capturedDays: days });
    expect(await f.coordinator.getStats({})).toMatchObject({ gatePhase: 'open', dirtyDays: 0 });
    expect(await f.coordinator.getOutstandingSnapshotCopyIntents({})).toEqual([]);
    expect(publishSnapshotManifest).toHaveBeenCalledOnce();
    expect(discoverSnapshotCopy).not.toHaveBeenCalled();
    expect(f.capacity.release).toHaveBeenCalledOnce();
    return {
      gateDurationMs: Date.now() - gateStartedAtMs,
      statusReads: vi.mocked(snapshotJobStatus).mock.calls.length,
    };
  }
});
