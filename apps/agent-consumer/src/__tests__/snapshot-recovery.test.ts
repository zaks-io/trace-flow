import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SnapshotTinybird from '../snapshot-tinybird';
import { AGENT_SNAPSHOT_TARGETS, startSnapshotCopy } from '../snapshot-tinybird';
import { makeSnapshotRunner } from './snapshot-runner-fixture';

vi.mock('../snapshot-tinybird', async (importOriginal) => ({
  ...(await importOriginal<typeof SnapshotTinybird>()),
  publishSnapshotManifest: vi.fn(),
  discoverSnapshotCopy: vi.fn(async () => null),
  snapshotJobStatus: vi.fn(async () => 'done'),
  startSnapshotCopy: vi.fn(),
}));

describe('operator recovery of an unstarted snapshot Copy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
    vi.mocked(startSnapshotCopy)
      .mockReset()
      .mockImplementation(async (_env, target) => `job-${target.replaceAll('_', '-')}`);
  });
  afterEach(() => vi.useRealTimers());

  async function blockedSnapshot() {
    vi.mocked(startSnapshotCopy).mockRejectedValueOnce(new Error('start response unavailable'));
    const f = await makeSnapshotRunner();
    expect(await f.finish()).toEqual({ status: 'blocked' });
    const [intent] = await f.coordinator.getOutstandingSnapshotCopyIntents({});
    if (!intent) throw new Error('Expected a preserved Copy intent');
    const input = {
      orgId: f.orgId,
      generation: intent.generation,
      reason: 'Operator verified that the Copy POST was never submitted',
      abandonUnstartedCopy: {
        target: intent.target,
        copyAttempt: intent.copyAttempt,
        startedAt: intent.startedAt,
      },
    };
    return { ...f, input };
  }

  it('retires the unpublished generation, reopens ingestion, and resumes retained days in a new generation', async () => {
    const f = await blockedSnapshot();
    const abandoned = await f.coordinator.resumeSnapshot(f.input);
    expect(abandoned).toMatchObject({
      check: null,
      failure: { generation: 1, reason: f.input.reason },
    });
    expect(await f.coordinator.getOutstandingSnapshotCopyIntents({})).toEqual([]);
    expect(await f.coordinator.getStats({})).toMatchObject({
      gatePhase: 'open',
      activeSnapshotGeneration: null,
      dirtyDays: 1,
    });
    expect(await f.wake()).toEqual({ status: 'blocked' });
    await f.coordinator.resumeSnapshot({
      orgId: f.orgId,
      generation: 1,
      reason: 'Verified abandoned generation; rebuild retained days',
    });
    expect(await f.finish()).toMatchObject({ status: 'complete', generation: 2 });
    expect(startSnapshotCopy).toHaveBeenCalledTimes(10);
    const generations = vi
      .mocked(startSnapshotCopy)
      .mock.calls.map(([, , plan]) => plan.generation);
    expect(generations).toEqual([1, ...Array<number>(9).fill(2)]);
  });

  it.each(['target', 'copyAttempt', 'startedAt', 'generation'] as const)(
    'rejects a stale %s without changing the preserved intent or gate',
    async (field) => {
      const f = await blockedSnapshot();
      const before = await f.coordinator.getOutstandingSnapshotCopyIntents({});
      const input = {
        ...f.input,
        abandonUnstartedCopy: { ...f.input.abandonUnstartedCopy },
      };
      if (field === 'generation') input.generation++;
      else if (field === 'target') input.abandonUnstartedCopy.target = AGENT_SNAPSHOT_TARGETS[1];
      else input.abandonUnstartedCopy[field]++;
      await expect(f.coordinator.resumeSnapshot(input)).rejects.toThrow('does not match');
      expect(await f.coordinator.getOutstandingSnapshotCopyIntents({})).toEqual(before);
      expect(await f.coordinator.getStats({})).toMatchObject({ gatePhase: 'snapshot' });
    },
  );

  it('rejects erasure and a live runner claim', async () => {
    const f = await blockedSnapshot();
    await f.coordinator.claimSnapshot({ claimId: 'live-runner' });
    await expect(f.coordinator.resumeSnapshot(f.input)).rejects.toThrow('does not match');
    await f.coordinator.beginErasure({});
    await expect(f.coordinator.resumeSnapshot(f.input)).rejects.toThrow('erasure');
    expect(await f.coordinator.getOutstandingSnapshotCopyIntents({})).toHaveLength(1);
  });

  it('rejects a known job receipt even after discovery checks block', async () => {
    const f = await blockedSnapshot();
    const progress = await f.coordinator.claimSnapshot({ claimId: 'receipt-owner' });
    if (!progress) throw new Error('Expected snapshot claim');
    await f.coordinator.attachSnapshotCopyJob({
      generation: 1,
      target: f.input.abandonUnstartedCopy.target,
      copyAttempt: 1,
      jobId: 'known-job',
      copyIndex: 0,
      claimId: progress.claimId,
    });
    await f.coordinator.releaseSnapshotClaim({ generation: 1, claimId: progress.claimId });
    await expect(f.coordinator.resumeSnapshot(f.input)).rejects.toThrow('does not match');
    expect(await f.coordinator.getOutstandingSnapshotCopyIntents({})).toEqual([
      expect.objectContaining({ jobId: 'known-job' }),
    ]);
  });

  it('rejects an unblocked missing receipt', async () => {
    const f = await blockedSnapshot();
    await f.coordinator.resumeSnapshot({
      orgId: f.orgId,
      generation: 1,
      reason: 'Provider receipt discovery restored',
    });
    await expect(f.coordinator.resumeSnapshot(f.input)).rejects.toThrow('does not match');
  });
});
