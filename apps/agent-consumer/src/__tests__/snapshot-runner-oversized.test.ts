import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SnapshotTinybird from '../snapshot-tinybird';
import {
  AGENT_SNAPSHOT_POLL_INTERVAL_MS,
  AGENT_SNAPSHOT_WORK_DEADLINE_MS,
  runAgentSnapshot,
  snapshotCopyPlans,
} from '../snapshot-runner';
import {
  AGENT_SNAPSHOT_TARGETS,
  publishSnapshotManifest,
  snapshotJobStatus,
  startSnapshotCopy,
} from '../snapshot-tinybird';
import { makeSnapshotRunner } from './snapshot-runner-fixture';

vi.mock('../snapshot-tinybird', async (importOriginal) => ({
  ...(await importOriginal<typeof SnapshotTinybird>()),
  publishSnapshotManifest: vi.fn().mockResolvedValue(undefined),
  snapshotJobStatus: vi.fn().mockResolvedValue('done'),
  startSnapshotCopy: vi.fn(),
}));

describe('oversized agent snapshot runner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-03-01T12:00:00.000Z'));
    vi.mocked(startSnapshotCopy).mockImplementation(
      async (_env, target, copy) => `job-${target}-${copy.copyAttempt}`,
    );
    vi.mocked(snapshotJobStatus).mockResolvedValue('done');
    vi.mocked(publishSnapshotManifest).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('copies a full retained linked component in bounded chunks before one manifest', async () => {
    const dirtyDays = retainedDays(367);
    const snapshot = { generation: 3, dirtyDays };
    const copies = snapshotCopyPlans({ orgId: 'org-1', ...snapshot });
    const { coordinator, env } = makeSnapshotRunner(snapshot);

    await expect(runAgentSnapshot(env, 'org-1')).resolves.toEqual({
      status: 'complete',
      generation: 3,
      capturedDays: 367,
      catchupQueued: false,
    });

    expect(copies).toHaveLength(12);
    expect(copies.map((copy) => copy.dirtyDays.length)).toEqual([
      31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 26,
    ]);
    expect(copies.map((copy) => copy.copyAttempt)).toEqual([
      48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59,
    ]);
    expect(copies.flatMap((copy) => copy.dirtyDays)).toEqual(dirtyDays);
    expect(startSnapshotCopy).toHaveBeenCalledTimes(AGENT_SNAPSHOT_TARGETS.length * copies.length);
    const startedCopies = vi.mocked(startSnapshotCopy).mock.calls.map((call) => call[2]);
    expect(startedCopies.slice(0, AGENT_SNAPSHOT_TARGETS.length)).toEqual(
      Array(AGENT_SNAPSHOT_TARGETS.length).fill(copies[0]),
    );
    expect(startedCopies.every((copy) => copy.dirtyDays.length <= 31)).toBe(true);
    expect(publishSnapshotManifest).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ orgId: 'org-1', ...snapshot, publishedAtMs: expect.any(Number) }),
    );
    expect(coordinator.finishSnapshot).toHaveBeenCalledAfter(vi.mocked(publishSnapshotManifest));
  });

  it('hands off an oversized generation with its current job intent intact', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T17:40:00.000Z'));
    vi.mocked(snapshotJobStatus).mockResolvedValue('working');
    const snapshot = { generation: 3, dirtyDays: retainedDays(32) };
    const { coordinator, env } = makeSnapshotRunner(snapshot);

    const running = runAgentSnapshot(env, 'org-1');
    await vi.advanceTimersByTimeAsync(
      AGENT_SNAPSHOT_WORK_DEADLINE_MS + AGENT_SNAPSHOT_POLL_INTERVAL_MS,
    );

    await expect(running).resolves.toMatchObject({
      status: 'continued',
      generation: 3,
      nextCopyIndex: 0,
    });
    expect(coordinator.failSnapshot).not.toHaveBeenCalled();
    expect(coordinator.settleSnapshotCopyIntent).not.toHaveBeenCalled();
    expect(coordinator.releaseSnapshotClaim).toHaveBeenCalled();
  });

  it('fails before starting a CopyAttempt that exceeds safe integers', async () => {
    const snapshot = {
      generation: Math.floor(Number.MAX_SAFE_INTEGER / 16) + 1,
      dirtyDays: retainedDays(32),
    };
    const { coordinator, env } = makeSnapshotRunner(snapshot);

    await expect(runAgentSnapshot(env, 'org-1')).rejects.toThrow(
      'CopyAttempt exceeds the safe integer range',
    );
    expect(coordinator.failSnapshot).toHaveBeenCalledWith({
      generation: snapshot.generation,
      claimId: expect.any(String),
    });
    expect(coordinator.recordSnapshotCopyIntent).not.toHaveBeenCalled();
    expect(startSnapshotCopy).not.toHaveBeenCalled();
  });
});

function retainedDays(count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    new Date(Date.UTC(2024, 2, 1) - index * 86_400_000).toISOString().slice(0, 10),
  ).sort();
}
