import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SnapshotTinybird from '../snapshot-tinybird';
import { runAgentSnapshot } from '../snapshot-runner';
import {
  AGENT_SNAPSHOT_TARGETS,
  discoverSnapshotCopy,
  publishSnapshotManifest,
  SnapshotCopyStartRejectedError,
  snapshotJobStatus,
  startSnapshotCopy,
} from '../snapshot-tinybird';
import { makeSnapshotRunner } from './snapshot-runner-fixture';

vi.mock('../snapshot-tinybird', async (importOriginal) => ({
  ...(await importOriginal<typeof SnapshotTinybird>()),
  publishSnapshotManifest: vi.fn(),
  discoverSnapshotCopy: vi.fn(),
  snapshotJobStatus: vi.fn(),
  startSnapshotCopy: vi.fn(),
}));

describe('durable snapshot runner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
    vi.mocked(startSnapshotCopy)
      .mockReset()
      .mockImplementation(async (_env, target) => `job-${target.replaceAll('_', '-')}`);
    vi.mocked(snapshotJobStatus).mockReset().mockResolvedValue('done');
    vi.mocked(publishSnapshotManifest).mockReset().mockResolvedValue(undefined);
    vi.mocked(discoverSnapshotCopy).mockReset().mockResolvedValue(null);
  });
  afterEach(() => vi.useRealTimers());

  it('schedules one Copy at a time and atomically publishes after all nine finish', async () => {
    const f = await makeSnapshotRunner();
    await f.coordinator.scheduleSnapshot({ orgId: f.orgId });
    const started = Date.now();
    expect(await f.wake()).toMatchObject({ status: 'continued', nextCopyIndex: 0 });
    expect(startSnapshotCopy).toHaveBeenCalledOnce();
    expect(snapshotJobStatus).not.toHaveBeenCalled();
    expect(await runAgentSnapshot(f.env, f.orgId)).toEqual({ status: 'scheduled' });
    expect(await f.finish()).toMatchObject({ status: 'complete' });
    expect(Date.now() - started).toBeLessThan(5 * 60_000);
    expect(startSnapshotCopy).toHaveBeenCalledTimes(9);
    expect(snapshotJobStatus).toHaveBeenCalledTimes(9);
    expect(discoverSnapshotCopy).not.toHaveBeenCalled();
    expect(publishSnapshotManifest).toHaveBeenCalledOnce();
    expect(f.queueSend).not.toHaveBeenCalled();
    expect(f.capacity.release).toHaveBeenCalledWith({ orgId: f.orgId, generation: 1 });
    expect(await f.coordinator.getStats({})).toMatchObject({ gatePhase: 'open', dirtyDays: 0 });
  });

  it('returns without polling and fences duplicate wake-ups for a running job', async () => {
    vi.mocked(snapshotJobStatus).mockResolvedValue('working');
    const f = await makeSnapshotRunner();
    await f.wake();
    await f.wake();
    expect(snapshotJobStatus).toHaveBeenCalledOnce();
    await runAgentSnapshot(f.env, f.orgId);
    await runAgentSnapshot(f.env, f.orgId);
    expect(snapshotJobStatus).toHaveBeenCalledOnce();
    expect(publishSnapshotManifest).not.toHaveBeenCalled();
    expect(f.capacity.release).not.toHaveBeenCalled();
    expect(await f.coordinator.getStats({})).toMatchObject({ gatePhase: 'snapshot' });
  });

  it('blocks an indefinitely running job after its persisted check budget', async () => {
    vi.mocked(snapshotJobStatus).mockResolvedValue('working');
    const f = await makeSnapshotRunner();
    expect(await f.finish()).toEqual({ status: 'blocked' });
    expect(snapshotJobStatus).toHaveBeenCalledTimes(15);
    expect(discoverSnapshotCopy).not.toHaveBeenCalled();
    expect(publishSnapshotManifest).not.toHaveBeenCalled();
    expect(f.capacity.release).not.toHaveBeenCalled();
  });

  it('recovers a lost start response once, without submitting the Copy twice', async () => {
    vi.mocked(startSnapshotCopy).mockRejectedValueOnce(new Error('connection closed'));
    vi.mocked(discoverSnapshotCopy).mockResolvedValueOnce({
      id: 'recovered-job',
      status: 'working',
    });
    const f = await makeSnapshotRunner();
    await f.wake();
    expect(publishSnapshotManifest).not.toHaveBeenCalled();
    expect(await f.finish()).toMatchObject({ status: 'complete' });
    expect(discoverSnapshotCopy).toHaveBeenCalledOnce();
    expect(startSnapshotCopy).toHaveBeenCalledTimes(9);
    expect(snapshotJobStatus).toHaveBeenCalledWith(f.env, 'recovered-job');
  });

  it('bounds ambiguous-start recovery and resumes the same receipt after operator intervention', async () => {
    vi.mocked(startSnapshotCopy).mockRejectedValueOnce(new Error('connection closed'));
    const f = await makeSnapshotRunner();
    expect(await f.finish()).toEqual({ status: 'blocked' });
    expect(discoverSnapshotCopy).toHaveBeenCalledTimes(3);
    expect(startSnapshotCopy).toHaveBeenCalledOnce();
    const state = await f.coordinator.getSnapshotSchedule({});
    expect(state.check?.blockedReason).toContain('receipt');
    await f.coordinator.resumeSnapshot({
      orgId: f.orgId,
      generation: 1,
      reason: 'Provider receipt now available',
    });
    vi.mocked(discoverSnapshotCopy).mockResolvedValueOnce({ id: 'recovered-job', status: 'done' });
    expect(await f.finish()).toMatchObject({ status: 'complete' });
    expect(startSnapshotCopy).toHaveBeenCalledTimes(9);
  });

  it('uses exceptional recovery for a missing Jobs API receipt, not on every pending response', async () => {
    vi.mocked(snapshotJobStatus).mockResolvedValueOnce(null);
    vi.mocked(discoverSnapshotCopy).mockResolvedValueOnce({
      id: `job-${AGENT_SNAPSHOT_TARGETS[0].replaceAll('_', '-')}`,
      status: 'done',
    });
    const f = await makeSnapshotRunner();
    await f.wake();
    await f.wake();
    expect(discoverSnapshotCopy).not.toHaveBeenCalled();
    expect(await f.finish()).toMatchObject({ status: 'complete' });
    expect(discoverSnapshotCopy).toHaveBeenCalledOnce();
  });

  it('blocks a terminal job across queue retries and new dirty scheduling until operator resume', async () => {
    vi.mocked(snapshotJobStatus).mockResolvedValueOnce('error');
    const f = await makeSnapshotRunner();
    await f.wake();
    await expect(f.wake()).rejects.toThrow('Copy job');
    expect(publishSnapshotManifest).not.toHaveBeenCalled();
    expect(await f.coordinator.getStats({})).toMatchObject({ gatePhase: 'open', dirtyDays: 1 });
    expect(await f.coordinator.getSnapshotSchedule({})).toMatchObject({
      failure: { generation: 1, reason: expect.stringContaining('job') },
    });
    expect(f.capacity.release).toHaveBeenCalledOnce();
    await f.coordinator.scheduleSnapshot({ orgId: f.orgId });
    for (let attempt = 0; attempt < 3; attempt += 1)
      expect(await runAgentSnapshot(f.env, f.orgId)).toEqual({ status: 'blocked' });
    await expect(f.coordinator.beginSnapshot({ claimId: 'unexpected' })).rejects.toThrow(
      'operator recovery',
    );
    expect(startSnapshotCopy).toHaveBeenCalledOnce();
    await f.coordinator.resumeSnapshot({
      orgId: f.orgId,
      generation: 1,
      reason: 'Provider job failure investigated',
    });
    expect(await f.finish()).toMatchObject({ status: 'complete', generation: 2 });
    expect(startSnapshotCopy).toHaveBeenCalledTimes(10);
  });

  it('blocks a rejected start without retaining an intent, then resumes a new generation', async () => {
    vi.mocked(startSnapshotCopy).mockRejectedValueOnce(new SnapshotCopyStartRejectedError(400));
    const f = await makeSnapshotRunner();
    await expect(f.wake()).rejects.toThrow('HTTP 400');
    expect(await f.coordinator.getOutstandingSnapshotCopyIntents({})).toEqual([]);
    expect(await f.coordinator.getStats({})).toMatchObject({ gatePhase: 'open', dirtyDays: 1 });
    expect(await f.coordinator.getSnapshotSchedule({})).toMatchObject({
      failure: { generation: 1, reason: 'Snapshot Copy start failed: HTTP 400' },
    });
    expect(f.capacity.release).toHaveBeenCalledOnce();
    await f.coordinator.scheduleSnapshotContinuation({ orgId: f.orgId });
    expect(await f.wake()).toEqual({ status: 'blocked' });
    expect(startSnapshotCopy).toHaveBeenCalledOnce();
    await f.coordinator.resumeSnapshot({
      orgId: f.orgId,
      generation: 1,
      reason: 'Provider request corrected',
    });
    expect(await f.finish()).toMatchObject({ status: 'complete', generation: 2 });
  });

  it('does not start any Copy without a durable capacity slot', async () => {
    const f = await makeSnapshotRunner();
    f.capacity.acquire.mockResolvedValue(false);
    expect(await f.wake()).toMatchObject({ status: 'scheduled' });
    expect(await f.coordinator.getStats({})).toMatchObject({
      gatePhase: 'open',
      dirtyDays: 1,
      activeSnapshotGeneration: null,
    });
    expect(startSnapshotCopy).not.toHaveBeenCalled();
    expect(snapshotJobStatus).not.toHaveBeenCalled();
    f.capacity.acquire.mockResolvedValue(true);
    expect(await f.finish()).toMatchObject({ status: 'complete' });
  });

  it('retries manifest publication with the same timestamp and without rerunning Copies', async () => {
    vi.mocked(publishSnapshotManifest).mockRejectedValueOnce(new Error('lost manifest response'));
    const f = await makeSnapshotRunner();
    expect(await f.finish()).toMatchObject({ status: 'complete' });
    expect(startSnapshotCopy).toHaveBeenCalledTimes(9);
    const calls = vi.mocked(publishSnapshotManifest).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![1]).toEqual(calls[1]![1]);
  });

  it('does not continue a snapshot once erasure starts', async () => {
    const f = await makeSnapshotRunner();
    await f.wake();
    await f.coordinator.beginErasure({});
    expect(await f.wake()).toEqual({ status: 'idle' });
    expect(snapshotJobStatus).not.toHaveBeenCalled();
    expect(f.capacity.release).not.toHaveBeenCalled();
  });
});
