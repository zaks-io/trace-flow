import { describe, expect, it, vi } from 'vitest';
import { fetchPipe } from '@trace-flow/tinybird-client';
import type * as TinybirdClient from '@trace-flow/tinybird-client';
import type { AgentConsumerEnv } from '../context';
import { eraseAgentOrganization } from '../organization-erasure';

vi.mock('@trace-flow/tinybird-client', async (importOriginal) => ({
  ...(await importOriginal<typeof TinybirdClient>()),
  fetchPipe: vi.fn(),
}));

function fixture(jobId?: string) {
  let settled = false;
  const intent = {
    generation: 1,
    target: 'agent_usage_daily_snapshots',
    copyAttempt: 16,
    startedAt: Date.now(),
    ...(jobId ? { jobId } : {}),
  };
  const coordinator = {
    beginErasure: vi.fn(async () => undefined),
    getOutstandingSnapshotCopyIntents: vi.fn(async () => [intent]),
    attachErasureSnapshotCopyJob: vi.fn(async () => undefined),
    settleErasureSnapshotCopyIntent: vi.fn(async () => {
      settled = true;
    }),
    abandonErasureSnapshot: vi.fn(async () => undefined),
    getErasureState: vi.fn(async () => ({ ready: settled })),
  };
  const eraseOrganizationData = vi.fn(async () => ({ erased: true }));
  const discardOrganizationDlq = vi.fn(async () => ({
    deleted: 1,
    nextAfterId: null as number | null,
  }));
  const list = vi.fn(async ({ prefix }: { prefix: string }) => ({
    objects: [{ key: `${prefix}delivery` }],
    truncated: false,
  }));
  const remove = vi.fn(async () => undefined);
  const env = {
    TINYBIRD_HOST: 'https://tinybird.test',
    TINYBIRD_AGENT_SNAPSHOT_TOKEN: 'narrow-test-token',
    AGENT_DELIVERY_COORDINATOR: { getByName: vi.fn(() => coordinator) },
    AGENT_FACT_BATCHER: {
      getByName: vi.fn((name: string) => {
        if (name === 'org:org-1') return { eraseOrganizationData };
        if (name === 'org:__dlq__') return { discardOrganizationDlq };
        throw new Error('Unexpected erasure scope');
      }),
    },
    AGENT_DELIVERIES: { list, delete: remove },
  } as unknown as AgentConsumerEnv;
  return { env, coordinator, eraseOrganizationData, discardOrganizationDlq, list, remove };
}

describe('agent organization erasure', () => {
  it('keeps an unknown Copy start unresolved when discovery finds no job', async () => {
    const f = fixture();
    vi.mocked(fetchPipe).mockResolvedValueOnce([]);
    expect(await eraseAgentOrganization(f.env, 'org-1')).toEqual({ ready: false });
    expect(f.coordinator.settleErasureSnapshotCopyIntent).not.toHaveBeenCalled();
    expect(f.eraseOrganizationData).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('waits for discovered jobs to finish before deleting data', async () => {
    const f = fixture();
    vi.mocked(fetchPipe).mockResolvedValueOnce([{ job_id: 'job-1', status: 'working' }]);
    expect(await eraseAgentOrganization(f.env, 'org-1')).toEqual({ ready: false });
    expect(f.coordinator.attachErasureSnapshotCopyJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1' }),
    );
    expect(f.eraseOrganizationData).not.toHaveBeenCalled();
  });

  it('removes only the requested tenant buffers after confirmed job termination and legacy erasure', async () => {
    const f = fixture('job-1');
    vi.mocked(fetchPipe).mockResolvedValueOnce([{ job_id: 'job-1', status: 'done' }]);
    expect(await eraseAgentOrganization(f.env, 'org-1')).toEqual({ ready: true });
    expect(f.remove.mock.calls).toEqual([
      [['agent-deliveries/org-1/delivery']],
      [['agent-delivery-rows/org-1/delivery']],
    ]);
    expect(f.discardOrganizationDlq).toHaveBeenCalledWith('org-1', {
      afterId: undefined,
      limit: 100,
    });
  });

  it('continues the shared legacy DLQ scan without treating a partial page as complete', async () => {
    const f = fixture('job-1');
    vi.mocked(fetchPipe).mockResolvedValueOnce([{ job_id: 'job-1', status: 'done' }]);
    f.discardOrganizationDlq.mockResolvedValueOnce({ deleted: 0, nextAfterId: 200 });
    expect(await eraseAgentOrganization(f.env, 'org-1', 100)).toEqual({
      ready: false,
      nextAfterId: 200,
    });
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('rejects a different job receipt instead of assuming the original job settled', async () => {
    const f = fixture('job-1');
    vi.mocked(fetchPipe).mockResolvedValueOnce([{ job_id: 'job-2', status: 'done' }]);
    await expect(eraseAgentOrganization(f.env, 'org-1')).rejects.toThrow('durable intent');
    expect(f.remove).not.toHaveBeenCalled();
  });
});
