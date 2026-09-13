import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SnapshotTinybird from '../snapshot-tinybird';
import {
  AGENT_SNAPSHOT_POLL_INTERVAL_MS,
  AGENT_SNAPSHOT_WORK_DEADLINE_MS,
  runAgentSnapshot,
} from '../snapshot-runner';
import {
  AGENT_SNAPSHOT_TARGETS,
  publishSnapshotManifest,
  SnapshotCopyStartRejectedError,
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

const plan = { generation: 3, dirtyDays: ['2026-09-11', '2026-09-12'] };

describe('agent snapshot runner', () => {
  beforeEach(() => {
    vi.mocked(startSnapshotCopy).mockReset();
    vi.mocked(startSnapshotCopy).mockImplementation(async (_env, target) => `job-${target}`);
    vi.mocked(snapshotJobStatus).mockReset();
    vi.mocked(snapshotJobStatus).mockResolvedValue('done');
    vi.mocked(publishSnapshotManifest).mockReset();
    vi.mocked(publishSnapshotManifest).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('runs all nine Copy jobs serially and commits one immutable manifest', async () => {
    const { coordinator, env, queueSend } = makeSnapshotRunner(plan, {
      finalStats: { dirtyDays: 3 },
    });

    await expect(runAgentSnapshot(env, 'org-1')).resolves.toEqual({
      status: 'complete',
      generation: 3,
      capturedDays: 2,
      catchupQueued: true,
    });

    expect(startSnapshotCopy).toHaveBeenCalledTimes(AGENT_SNAPSHOT_TARGETS.length);
    expect(coordinator.settleSnapshotCopyIntent).toHaveBeenCalledTimes(
      AGENT_SNAPSHOT_TARGETS.length,
    );
    expect(
      vi.mocked(coordinator.settleSnapshotCopyIntent).mock.invocationCallOrder.at(-1),
    ).toBeLessThan(vi.mocked(publishSnapshotManifest).mock.invocationCallOrder[0]!);
    expect(publishSnapshotManifest).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        orgId: 'org-1',
        ...plan,
        publishedAtMs: expect.any(Number),
      }),
    );
    expect(coordinator.finishSnapshot).toHaveBeenCalledAfter(vi.mocked(publishSnapshotManifest));
    expect(coordinator.failSnapshot).not.toHaveBeenCalled();
    expect(queueSend).toHaveBeenCalledWith({ type: 'agent-snapshot', org_id: 'org-1' });
  });

  it('retries while another worker holds the active generation claim', async () => {
    const retryable = Object.assign(new Error('active claim'), { retryable: true });
    const { coordinator, env } = makeSnapshotRunner(plan, {
      initialStats: { gatePhase: 'snapshot' },
      overrides: { claimSnapshot: vi.fn().mockRejectedValue(retryable) },
    });

    await expect(runAgentSnapshot(env, 'org-1')).resolves.toEqual({
      status: 'retry',
      reason: 'gate-active',
    });
    expect(coordinator.requestSnapshot).not.toHaveBeenCalled();
    expect(coordinator.beginSnapshot).not.toHaveBeenCalled();
  });

  it('acks obsolete snapshot work after erasure without starting a Copy', async () => {
    const { coordinator, env } = makeSnapshotRunner(plan, {
      initialStats: { erasureStarted: true },
    });

    await expect(runAgentSnapshot(env, 'org-1')).resolves.toEqual({ status: 'idle' });
    expect(coordinator.requestSnapshot).not.toHaveBeenCalled();
    expect(coordinator.recordSnapshotCopyIntent).not.toHaveBeenCalled();
    expect(startSnapshotCopy).not.toHaveBeenCalled();
  });

  it('keeps the draining gate until active deliveries finish', async () => {
    const { coordinator, env } = makeSnapshotRunner(plan, {
      initialStats: { gatePhase: 'draining', activeDeliveries: 2 },
    });

    await expect(runAgentSnapshot(env, 'org-1')).resolves.toEqual({
      status: 'retry',
      reason: 'deliveries-draining',
    });
    expect(coordinator.requestSnapshot).not.toHaveBeenCalled();
    expect(coordinator.beginSnapshot).not.toHaveBeenCalled();
  });

  it('begins an existing drain after its active deliveries finish', async () => {
    const { coordinator, env } = makeSnapshotRunner(plan, {
      initialStats: { gatePhase: 'draining', activeDeliveries: 0 },
    });

    await expect(runAgentSnapshot(env, 'org-1')).resolves.toMatchObject({
      status: 'complete',
      generation: 3,
    });
    expect(coordinator.requestSnapshot).not.toHaveBeenCalled();
    expect(coordinator.beginSnapshot).toHaveBeenCalledOnce();
  });

  it.each([
    ['lost response', new Error('connection closed')],
    ['HTTP 502 after acceptance', new Error('Snapshot Copy start outcome is unknown: HTTP 502')],
  ])('retains and hands off an unknown Copy start after %s', async (_name, error) => {
    vi.mocked(startSnapshotCopy).mockRejectedValueOnce(error);
    const { coordinator, env, queueSend } = makeSnapshotRunner(plan);

    await expect(runAgentSnapshot(env, 'org-1')).resolves.toEqual({
      status: 'continued',
      generation: 3,
      capturedDays: 2,
      nextCopyIndex: 0,
    });
    expect(coordinator.recordSnapshotCopyIntent).toHaveBeenCalledOnce();
    expect(coordinator.rejectSnapshotCopyIntent).not.toHaveBeenCalled();
    expect(coordinator.failSnapshot).not.toHaveBeenCalled();
    expect(coordinator.scheduleSnapshotContinuation).toHaveBeenCalledWith({ orgId: 'org-1' });
    expect(coordinator.releaseSnapshotClaim).toHaveBeenCalled();
    expect(queueSend).toHaveBeenCalledWith({ type: 'agent-snapshot', org_id: 'org-1' });
  });

  it('removes a definitively rejected 4xx intent before failing the generation', async () => {
    vi.mocked(startSnapshotCopy).mockRejectedValueOnce(new SnapshotCopyStartRejectedError(400));
    const { coordinator, env } = makeSnapshotRunner(plan);

    await expect(runAgentSnapshot(env, 'org-1')).rejects.toThrow('HTTP 400');
    expect(coordinator.rejectSnapshotCopyIntent).toHaveBeenCalledOnce();
    expect(coordinator.failSnapshot).toHaveBeenCalledWith({
      generation: 3,
      claimId: expect.any(String),
    });
  });

  it('settles a failed known job and retains the generation dirty days', async () => {
    vi.mocked(snapshotJobStatus).mockResolvedValueOnce('error');
    const { coordinator, env } = makeSnapshotRunner(plan);

    await expect(runAgentSnapshot(env, 'org-1')).rejects.toThrow('Copy job');
    expect(coordinator.settleSnapshotCopyIntent).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error' }),
    );
    expect(coordinator.failSnapshot).toHaveBeenCalledWith({
      generation: 3,
      claimId: expect.any(String),
    });
  });

  it('hands off before the four-minute invocation deadline while a job is running', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T17:40:00.000Z'));
    vi.mocked(snapshotJobStatus).mockResolvedValue('working');
    const { coordinator, env } = makeSnapshotRunner(plan);

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
  });

  it('abandons a completed Copy set that crossed midnight out of retention', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-14T00:01:00.000Z'));
    const expiredPlan = { generation: 3, dirtyDays: ['2025-09-13'] };
    const { coordinator, env } = makeSnapshotRunner(expiredPlan);

    await expect(runAgentSnapshot(env, 'org-1')).rejects.toThrow('retention boundary');
    expect(coordinator.settleSnapshotCopyIntent).toHaveBeenCalledTimes(
      AGENT_SNAPSHOT_TARGETS.length,
    );
    expect(coordinator.failSnapshot).toHaveBeenCalledWith({
      generation: 3,
      claimId: expect.any(String),
    });
    expect(publishSnapshotManifest).not.toHaveBeenCalled();
  });

  it('does not treat an unrelated retryable property as coordinator contention', async () => {
    const { env } = makeSnapshotRunner(plan, {
      initialStats: { gatePhase: 'snapshot' },
      overrides: {
        claimSnapshot: vi.fn().mockRejectedValue({ retryable: false, message: 'corrupt state' }),
      },
    });
    await expect(runAgentSnapshot(env, 'org-1')).rejects.toEqual({
      retryable: false,
      message: 'corrupt state',
    });
  });
});
