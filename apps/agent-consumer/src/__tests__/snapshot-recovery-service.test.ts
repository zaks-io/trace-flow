import { createExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentConsumerEnv } from '../context';
import { TraceRecovery } from '../index';
import type { AgentSnapshotCopyIntent } from '../agent-ingestion-erasure';

const intent: AgentSnapshotCopyIntent = {
  generation: 7,
  target: 'agent_repositories_snapshots',
  copyAttempt: 7,
  startedAt: 1_791_000_000_000,
};
const options = {
  generation: intent.generation,
  reason: 'Operator verified original invocation never submitted the Copy POST',
  abandonUnstartedCopy: {
    target: intent.target,
    copyAttempt: intent.copyAttempt,
    startedAt: intent.startedAt,
  },
};

function fixture(jobs: { job_id: string; status: string }[], status = 200) {
  const fetch = vi.fn(
    async (_url: string) => new Response(JSON.stringify({ data: jobs }), { status }),
  );
  vi.stubGlobal('fetch', fetch);
  const resume = vi.fn(async () => ({ failure: { generation: 7 } }));
  const coordinator = {
    getOutstandingSnapshotCopyIntents: vi.fn(async () => [intent]),
    getStats: vi.fn(async () => ({ gatePhase: 'snapshot' })),
    getSnapshotSchedule: vi.fn(async () => ({ check: { generation: 7 } })),
    resumeSnapshot: resume,
  };
  const env = {
    TINYBIRD_HOST: 'https://api.tinybird.test',
    TINYBIRD_AGENT_SNAPSHOT_TOKEN: 'snapshot-token',
    AGENT_DELIVERY_COORDINATOR: { getByName: () => coordinator },
  } as unknown as AgentConsumerEnv;
  return { service: new TraceRecovery(createExecutionContext(), env), fetch, resume, coordinator };
}

afterEach(() => vi.unstubAllGlobals());

describe('private snapshot recovery provider checks', () => {
  it('queries the exact provider intent before delegating retirement', async () => {
    const f = fixture([]);
    await f.service.resumeSnapshot('org-1', options);
    expect(f.fetch).toHaveBeenCalledOnce();
    const url = new URL(f.fetch.mock.calls[0]![0]);
    expect(url.pathname).toBe('/v0/pipes/agent_snapshot_copy_intent_jobs.json');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      org_id: 'org-1',
      generation: '7',
      target: intent.target,
      copy_attempt: '7',
      started_at_ms: String(intent.startedAt),
    });
    expect(f.resume).toHaveBeenCalledWith({ ...options, orgId: 'org-1' });
  });

  it.each(['working', 'done', 'error'])(
    'refuses retirement when the provider reports a %s job',
    async (status) => {
      const f = fixture([{ job_id: 'existing-job', status }]);
      await expect(f.service.resumeSnapshot('org-1', options)).rejects.toThrow('provider job');
      expect(f.resume).not.toHaveBeenCalled();
    },
  );

  it('fails closed when provider discovery is denied or the intent changed', async () => {
    const denied = fixture([], 403);
    await expect(denied.service.resumeSnapshot('org-1', options)).rejects.toThrow();
    expect(denied.resume).not.toHaveBeenCalled();
    const stale = fixture([]);
    await expect(
      stale.service.resumeSnapshot('org-1', {
        ...options,
        abandonUnstartedCopy: { ...options.abandonUnstartedCopy, startedAt: intent.startedAt + 1 },
      }),
    ).rejects.toThrow('does not match');
    expect(stale.fetch).not.toHaveBeenCalled();
    expect(stale.resume).not.toHaveBeenCalled();
  });

  it('offers read-only provider discovery without changing ordinary inspection', async () => {
    const f = fixture([{ job_id: 'existing-job', status: 'done' }]);
    await f.service.inspectDeliveryStatus('org-1', {});
    expect(f.fetch).not.toHaveBeenCalled();
    expect(await f.service.inspectDeliveryStatus('org-1', { discoverCopies: true })).toMatchObject({
      snapshotCopyDiscovery: [{ intent, job: { id: 'existing-job', status: 'done' } }],
    });
    expect(f.resume).not.toHaveBeenCalled();
  });

  it('does not retire an intent when provider discovery returns a malformed success response', async () => {
    const f = fixture([]);
    f.fetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await expect(f.service.resumeSnapshot('org-1', options)).rejects.toThrow('no data array');
    expect(f.resume).not.toHaveBeenCalled();
  });
});
