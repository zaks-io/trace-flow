import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureSafeException } from '@trace-flow/utils/sentry-tracing';
import type * as SentryTracing from '@trace-flow/utils/sentry-tracing';
import { AGENT_SNAPSHOT_TARGETS, TinybirdQueryError } from '@trace-flow/tinybird-client';
import type * as SnapshotTinybird from '../snapshot-tinybird';
import {
  SnapshotCopyStartRejectedError,
  SnapshotProviderError,
  startSnapshotCopy,
  discoverSnapshotCopy,
  snapshotJobStatus,
} from '../snapshot-tinybird';
import { beforeSnapshotDeadline, SnapshotDeadlineError } from '../snapshot-runner-support';
import { captureSnapshotException } from '../snapshot-diagnostics';
import { makeSnapshotRunner } from './snapshot-runner-fixture';

vi.mock('@trace-flow/utils/sentry-tracing', async (importOriginal) => ({
  ...(await importOriginal<typeof SentryTracing>()),
  captureSafeException: vi.fn(),
}));
vi.mock('../snapshot-tinybird', async (importOriginal) => ({
  ...(await importOriginal<typeof SnapshotTinybird>()),
  publishSnapshotManifest: vi.fn(),
  snapshotJobStatus: vi.fn(async () => 'done'),
  startSnapshotCopy: vi.fn(async () => 'job-1'),
  discoverSnapshotCopy: vi.fn(),
}));

describe('snapshot failure diagnostics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
    vi.clearAllMocks();
    vi.mocked(startSnapshotCopy).mockResolvedValue('job-1');
    vi.mocked(discoverSnapshotCopy).mockResolvedValue(null);
  });
  afterEach(() => vi.useRealTimers());

  it('reports the rejected Copy stage and progress while preserving terminal failure fencing', async () => {
    const error = new SnapshotCopyStartRejectedError(400);
    vi.mocked(startSnapshotCopy).mockRejectedValueOnce(error);
    const f = await makeSnapshotRunner();
    await expect(f.wake()).rejects.toThrow('HTTP 400');
    expect(captureSafeException).toHaveBeenCalledExactlyOnceWith(
      error,
      expect.objectContaining({
        message: 'Snapshot Copy start rejected',
        diagnostics: expect.objectContaining({
          type: 'SnapshotCopyStartRejectedError',
          context: expect.objectContaining({
            stage: 'start-copy',
            orgId: f.orgId,
            generation: 1,
            copyIndex: 0,
            copyAttempt: 1,
            httpStatus: 400,
            target: AGENT_SNAPSHOT_TARGETS[0],
          }),
        }),
      }),
    );
    expect(await f.coordinator.getSnapshotSchedule({})).toMatchObject({
      failure: { generation: 1 },
    });
    expect(await f.wake()).toEqual({ status: 'blocked' });
    expect(startSnapshotCopy).toHaveBeenCalledOnce();
  });

  it('reports receipt-recovery failures without exporting provider content or duplicating Copy submission', async () => {
    vi.mocked(startSnapshotCopy).mockRejectedValueOnce(new TypeError('private start response'));
    const error = new TinybirdQueryError('private query response', 503);
    vi.mocked(discoverSnapshotCopy).mockRejectedValueOnce(error);
    const f = await makeSnapshotRunner();
    await f.wake();
    await f.wake();
    expect(captureSafeException).toHaveBeenLastCalledWith(
      error,
      expect.objectContaining({
        diagnostics: expect.objectContaining({
          type: 'TinybirdQueryError',
          context: expect.objectContaining({
            stage: 'recover-copy-receipt',
            generation: 1,
            copyIndex: 0,
            httpStatus: 503,
          }),
        }),
      }),
    );
    expect(startSnapshotCopy).toHaveBeenCalledOnce();
    expect(await f.coordinator.getStats({})).toMatchObject({ gatePhase: 'snapshot' });
    for (const [, details] of vi.mocked(captureSafeException).mock.calls)
      expect(JSON.stringify(details)).not.toContain('private');
  });

  it('distinguishes deadline failures before work from failures during work', async () => {
    const start = vi.fn(async () => undefined);
    await expect(
      beforeSnapshotDeadline(start, Date.now(), 'private operation'),
    ).rejects.toMatchObject({ phase: 'before' });
    expect(start).not.toHaveBeenCalled();
    const pending = beforeSnapshotDeadline(
      () => new Promise(() => {}),
      Date.now() + 10,
      'private operation',
    );
    const rejected = expect(pending).rejects.toMatchObject({ phase: 'during' });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    captureSnapshotException(new SnapshotDeadlineError('during', 'private operation'), {
      stage: 'read-copy-status',
    });
    const [, details] = vi.mocked(captureSafeException).mock.calls.at(-1)!;
    expect(details).toMatchObject({
      message: 'Snapshot deadline reached during work',
      diagnostics: { type: 'SnapshotDeadlineError' },
    });
    expect(JSON.stringify(details)).not.toContain('private');
  });

  it.each(['start-copy', 'read-copy-status'] as const)(
    'retains the HTTP status for %s without changing ambiguous outcome recovery',
    async (stage) => {
      const error = new SnapshotProviderError(503, stage);
      const f = await makeSnapshotRunner();
      if (stage === 'read-copy-status') await f.wake();
      vi.mocked(
        stage === 'start-copy' ? startSnapshotCopy : snapshotJobStatus,
      ).mockRejectedValueOnce(error);
      expect(await f.wake()).toMatchObject({ status: 'continued' });
      expect(captureSafeException).toHaveBeenLastCalledWith(
        error,
        expect.objectContaining({
          diagnostics: expect.objectContaining({
            type: 'SnapshotProviderError',
            context: expect.objectContaining({ stage, httpStatus: 503 }),
          }),
        }),
      );
      expect(await f.coordinator.getStats({})).toMatchObject({ gatePhase: 'snapshot' });
      expect(startSnapshotCopy).toHaveBeenCalledOnce();
      expect(f.capacity.release).not.toHaveBeenCalled();
    },
  );

  it('includes the persisted check budget when receipt recovery blocks', async () => {
    const Sentry = await import('@sentry/cloudflare');
    vi.mocked(startSnapshotCopy).mockRejectedValueOnce(new TypeError('private start response'));
    const f = await makeSnapshotRunner();
    expect(await f.finish()).toEqual({ status: 'blocked' });
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'Snapshot Copy receipt could not be recovered',
      {
        level: 'error',
        tags: { operation: 'agent_snapshot_recovery' },
        extra: {
          orgId: f.orgId,
          generation: 1,
          copyIndex: 0,
          statusChecks: 0,
          recoveryChecks: 3,
          recoveryRequired: true,
        },
      },
    );
    expect(startSnapshotCopy).toHaveBeenCalledOnce();
  });
});
