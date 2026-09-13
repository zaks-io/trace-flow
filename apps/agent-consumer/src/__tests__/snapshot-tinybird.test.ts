import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPipe, insertRows } from '@trace-flow/tinybird-client';
import type * as TinybirdClient from '@trace-flow/tinybird-client';
import {
  publishSnapshotManifest,
  snapshotCopyAttempt,
  snapshotJobStatus,
  startSnapshotCopy,
  type SnapshotPlan,
  type SnapshotTinybirdEnv,
} from '../snapshot-tinybird';

vi.mock('@trace-flow/tinybird-client', async (importOriginal) => ({
  ...(await importOriginal<typeof TinybirdClient>()),
  fetchPipe: vi.fn(),
  insertRows: vi.fn().mockResolvedValue(undefined),
}));

const env: SnapshotTinybirdEnv = {
  TINYBIRD_HOST: 'https://api.tinybird.test',
  TINYBIRD_AGENT_SNAPSHOT_TOKEN: 'snapshot-token',
};
const plan: SnapshotPlan = {
  orgId: 'org-1',
  generation: 7,
  dirtyDays: ['2026-09-11', '2026-09-12'],
};
const copyPlan = { ...plan, copyAttempt: plan.generation };

describe('snapshot Tinybird transport', () => {
  beforeEach(() => {
    vi.mocked(fetchPipe).mockReset();
    vi.mocked(insertRows).mockClear();
  });

  it('derives bounded deterministic attempts for Copy chunks', () => {
    expect(snapshotCopyAttempt(7)).toBe(7);
    expect(snapshotCopyAttempt(7, 0)).toBe(112);
    expect(snapshotCopyAttempt(7, 11)).toBe(123);
    expect(() => snapshotCopyAttempt(7, 12)).toThrow('chunk index is out of range');
    expect(() => snapshotCopyAttempt(Math.floor(Number.MAX_SAFE_INTEGER / 16) + 1, 0)).toThrow(
      'exceeds the safe integer range',
    );
  });

  it('rejects an unrelated CopyAttempt before starting an external job', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      startSnapshotCopy(env, 'agent_session_signals_snapshots', {
        ...plan,
        copyAttempt: plan.generation + 1,
      }),
    ).rejects.toThrow('does not match its generation');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('starts a Copy job with the exact bounded parameter contract', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ job: { job_id: 'job-123', status: 'waiting' } }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(startSnapshotCopy(env, 'agent_session_signals_snapshots', copyPlan)).resolves.toBe(
      'job-123',
    );

    const [input, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(input.pathname).toBe('/v0/pipes/repair_agent_session_signals_snapshots/copy');
    expect(Object.fromEntries(input.searchParams)).toEqual({
      org_id: 'org-1',
      snapshot_days: '2026-09-11,2026-09-12',
      snapshot_generation: '7',
      copy_attempt: '7',
      _mode: 'append',
    });
    expect(init).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer snapshot-token' },
    });
  });

  it('classifies only a 4xx response as a definitive rejected start', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 400 })));
    await expect(
      startSnapshotCopy(env, 'agent_session_signals_snapshots', copyPlan),
    ).rejects.toMatchObject({ name: 'SnapshotCopyStartRejectedError' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 502 })));
    await expect(
      startSnapshotCopy(env, 'agent_session_signals_snapshots', copyPlan),
    ).rejects.toThrow('outcome is unknown: HTTP 502');
  });

  it('accepts only the four statuses returned by the bounded job pipe', async () => {
    vi.mocked(fetchPipe).mockImplementation(async (options) => {
      const row = { id: 'job-123', status: 'working' };
      return [options.schema!.parse(row)] as never;
    });
    await expect(snapshotJobStatus(env, 'job-123')).resolves.toBe('working');

    vi.mocked(fetchPipe).mockImplementation(async (options) => {
      return [options.schema!.parse({ id: 'job-123', status: 'cancelled' })] as never;
    });
    await expect(snapshotJobStatus(env, 'job-123')).rejects.toThrow('Invalid snapshot job status');
  });

  it('publishes one immutable manifest row for the complete captured group', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T17:40:00.123Z'));

    await publishSnapshotManifest(env, { ...plan, publishedAtMs: Date.now() });

    expect(insertRows).toHaveBeenCalledWith(
      [
        {
          OrgId: 'org-1',
          SnapshotGeneration: 7,
          SnapshotDays: ['2026-09-11', '2026-09-12'],
          PublishedAt: '2026-09-13 17:40:00.123',
        },
      ],
      'snapshot-token',
      'agent_snapshot_manifest',
      'https://api.tinybird.test',
    );
  });
});
