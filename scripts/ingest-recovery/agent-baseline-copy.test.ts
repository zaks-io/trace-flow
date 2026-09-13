import { describe, expect, test } from 'bun:test';
import { runBaselineCopy } from './agent-baseline-copy';
import {
  AgentTinybirdRequestError,
  type AgentRecoveryClient,
  type AgentTinybirdClient,
} from './agent-transport';
import type { BaselineCopyCheckpoint } from '../../apps/agent-consumer/src/baseline-copy-contract';

const window = { startDay: '2026-09-01', endDay: '2026-09-13' };
function fixture(initial: BaselineCopyCheckpoint | null = null) {
  let checkpoint = initial;
  let loseReceipt = false;
  let jobApiExpired = false;
  let jobs: Record<string, unknown>[] = [];
  const requests: string[] = [];
  const queries: string[] = [];
  const recovery = {
    org: 'org-proof',
    async call(method: string, input: Record<string, unknown>) {
      if (method === 'getBaselineCopy') return checkpoint;
      if (method === 'beginBaselineCopy') {
        checkpoint = { ...input, complete: false } as unknown as BaselineCopyCheckpoint;
        return { ...checkpoint, created: true };
      }
      if (method === 'confirmBaselineCopy') {
        checkpoint = { ...checkpoint, ...input } as BaselineCopyCheckpoint;
        return checkpoint;
      }
      throw new Error(`Unexpected recovery method ${method}`);
    },
  } as unknown as AgentRecoveryClient;
  const tb = {
    async request(path: string) {
      requests.push(path);
      if (path.startsWith('/v0/jobs/')) {
        if (jobApiExpired) throw new AgentTinybirdRequestError(path, 404);
        return { status: 'done' };
      }
      if (loseReceipt) throw new Error('Connection lost after submission');
      return { job: { job_id: 'job-one' } };
    },
    async sql(query: string) {
      queries.push(query);
      return { data: jobs, meta: [] };
    },
  } as unknown as AgentTinybirdClient;
  return {
    recovery,
    tb,
    requests,
    queries,
    get checkpoint() {
      return checkpoint;
    },
    loseReceipt() {
      loseReceipt = true;
    },
    expireJobApi() {
      jobApiExpired = true;
    },
    jobs(value: Record<string, unknown>[]) {
      jobs = value;
    },
  };
}

describe('baseline Copy restart safety', () => {
  test('a completed Copy is reused without writing again', async () => {
    const f = fixture();
    expect(await runBaselineCopy(f.tb, f.recovery, 'messages', window)).toBe('job-one');
    expect(f.checkpoint?.complete).toBe(true);
    expect(f.requests[0]).toContain('copy_attempt=');
    const count = f.requests.length;
    await runBaselineCopy(f.tb, f.recovery, 'messages', window);
    expect(f.requests).toHaveLength(count);
  });
  test('a lost submission response never causes a blind duplicate Copy', async () => {
    const f = fixture();
    f.loseReceipt();
    await expect(runBaselineCopy(f.tb, f.recovery, 'messages', window)).rejects.toThrow(
      'Connection lost',
    );
    expect(f.checkpoint?.jobId).toBeUndefined();
    await expect(runBaselineCopy(f.tb, f.recovery, 'messages', window)).rejects.toThrow(
      'unresolved',
    );
    expect(f.requests).toHaveLength(1);
    f.jobs([{ job_id: 'job-recovered', status: 'done' }]);
    expect(await runBaselineCopy(f.tb, f.recovery, 'messages', window)).toBe('job-recovered');
    expect(f.checkpoint?.complete).toBe(true);
    expect(f.requests.filter((path) => path.includes('/copy?'))).toHaveLength(1);
    expect(f.queries[f.queries.length - 1]).toContain("'copy_attempt'");
    expect(f.queries[f.queries.length - 1]).not.toContain('created_at >=');
  });
  test('an expired Jobs API receipt is completed from the exact jobs_log record', async () => {
    const f = fixture({
      category: 'messages',
      ...window,
      startedAt: 1,
      copyAttempt: 1,
      jobId: 'job-old',
      complete: false,
    });
    f.expireJobApi();
    f.jobs([{ job_id: 'job-old', status: 'done' }]);

    expect(await runBaselineCopy(f.tb, f.recovery, 'messages', window)).toBe('job-old');
    expect(f.queries[f.queries.length - 1]).toContain("job_id = 'job-old'");
    expect(f.checkpoint?.complete).toBe(true);
  });
  test('multiple matching jobs and changed windows require reconciliation', async () => {
    const f = fixture({
      category: 'messages',
      ...window,
      startedAt: 1,
      copyAttempt: 1,
      complete: false,
    });
    f.jobs([{ job_id: 'one' }, { job_id: 'two' }]);
    await expect(runBaselineCopy(f.tb, f.recovery, 'messages', window)).rejects.toThrow(
      'unresolved',
    );
    await expect(
      runBaselineCopy(f.tb, f.recovery, 'messages', { ...window, endDay: '2026-09-14' }),
    ).rejects.toThrow('retention window changed');
    expect(f.requests).toHaveLength(0);
  });
});
