import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type {
  BaselineCopyCheckpoint,
  BoundedBaselineCopyCheckpoint,
} from '../../apps/agent-consumer/src/baseline-copy-contract';
import { buildBaselineCopyPlan } from './agent-baseline-copy-plan';
import { runBoundedBaselineCopy } from './agent-bounded-baseline-copy';
import { verifyChunkSource, verifyCompletedChunkTarget } from './agent-bounded-baseline-proof';
import { chunkAgentDayRange } from './agent-day-chunks';
import { retainedMigrationWindow } from './agent-migration-proof';
import type { AgentRecoveryClient, AgentTinybirdClient } from './agent-transport';

const originalFetch = globalThis.fetch;
const originalAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const originalApiToken = process.env.CLOUDFLARE_API_TOKEN;
const guardRequests: string[] = [];

beforeAll(() => {
  process.env.CLOUDFLARE_ACCOUNT_ID = 'account-fixture';
  process.env.CLOUDFLARE_API_TOKEN = 'token-fixture';
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = String(input);
      guardRequests.push(url);
      if (url === 'https://collector.trace-flow.dev/v1/ingest') {
        return Response.json({ error: 'ingestion_maintenance' }, { status: 503 });
      }
      if (url.includes('/queues?')) {
        return Response.json({
          success: true,
          result: [
            { queue_name: 'agent-ingest-prod', queue_id: 'ingest-id' },
            { queue_name: 'agent-ingest-dlq-prod', queue_id: 'dlq-id' },
          ],
        });
      }
      if (url.includes('/queues/')) {
        return Response.json({ success: true, result: { backlog_count: 0 } });
      }
      throw new Error(`Unexpected guard request ${url}`);
    },
    { preconnect: originalFetch.preconnect },
  );
});

beforeEach(() => {
  guardRequests.length = 0;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  restore('CLOUDFLARE_ACCOUNT_ID', originalAccountId);
  restore('CLOUDFLARE_API_TOKEN', originalApiToken);
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function checkpoint(): BoundedBaselineCopyCheckpoint {
  const window = retainedMigrationWindow();
  const day = window.endDay;
  const proof = {
    category: 'tool_events' as const,
    rows: 2,
    days: [day],
    dailyStats: [{ day, rows: 2, projectedBytes: 20 }],
  };
  return {
    mode: 'bounded',
    category: proof.category,
    startDay: day,
    endDay: day,
    startedAt: 1,
    plan: buildBaselineCopyPlan(proof, { startDay: day, endDay: day }),
    completedJobs: [],
    complete: false,
  };
}

function fixture(initial = checkpoint()) {
  let state: BaselineCopyCheckpoint = structuredClone(initial);
  let jobs: Record<string, unknown>[] = [];
  let terminal: Record<string, unknown> = { job_id: 'job-chunk', status: 'done' };
  let loseResponse = false;
  const requests: string[] = [];
  const queries: string[] = [];
  const calls: string[] = [];
  const verificationChunk = chunkAgentDayRange(initial)[0]!;
  const recovery = {
    org: 'org-proof',
    async call(method: string, input: Record<string, unknown>) {
      calls.push(method);
      if (method === 'armBoundedBaselineCopyChunk') {
        const bounded = state as BoundedBaselineCopyCheckpoint;
        state = { ...bounded, activeJob: { copyAttempt: input.copyAttempt as number } };
        return { ...state, created: true };
      }
      if (method === 'confirmBoundedBaselineCopyChunk') {
        const bounded = state as BoundedBaselineCopyCheckpoint;
        state = {
          ...bounded,
          activeJob: { copyAttempt: input.copyAttempt as number, jobId: input.jobId as string },
        };
        return state;
      }
      if (method === 'completeBoundedBaselineCopyChunk') {
        const bounded = state as BoundedBaselineCopyCheckpoint;
        const { activeJob: _active, ...rest } = bounded;
        state = {
          ...rest,
          completedJobs: [
            ...bounded.completedJobs,
            { copyAttempt: input.copyAttempt as number, jobId: input.jobId as string },
          ],
        };
        return state;
      }
      if (method === 'completeBoundedBaselineCopy') {
        state = { ...state, complete: true } as BoundedBaselineCopyCheckpoint;
        return state;
      }
      throw new Error(`Unexpected recovery call ${method}`);
    },
  } as unknown as AgentRecoveryClient;
  const tb = {
    async request(path: string) {
      requests.push(path);
      if (path.startsWith('/v0/jobs/')) return terminal;
      if (loseResponse) throw new Error('lost chunk response');
      return { job: { job_id: 'job-chunk' } };
    },
    async sql(query: string) {
      queries.push(query);
      if (query.includes('tinybird.jobs_log')) return { data: jobs, meta: [] };
      if (query.includes('projected_bytes')) {
        return { data: [{ rows: 2, projected_bytes: 20 }], meta: [] };
      }
      if (query.includes('invalid_rows')) {
        return { data: [{ rows: 2, invalid_rows: 0 }], meta: [] };
      }
      if (query.includes('invalid_metadata')) {
        const rows = query.includes(`toDateTime('${verificationChunk.startDay}')`) ? 2 : 0;
        return {
          data: [
            {
              source_rows: rows,
              target_rows: rows,
              invalid_metadata: 0,
              missing_target: 0,
              unexpected_target: 0,
            },
          ],
          meta: [],
        };
      }
      if (query.includes('source_index')) {
        const rows = query.includes(`toDateTime('${verificationChunk.startDay}')`) ? 2 : 0;
        return {
          data: [{ source_rows: rows, target_rows: rows, missing_target: 0, unexpected_target: 0 }],
          meta: [],
        };
      }
      return { data: [{ rows: 0 }], meta: [] };
    },
  } as unknown as AgentTinybirdClient;
  return {
    tb,
    recovery,
    requests,
    queries,
    calls,
    state: () => state as BoundedBaselineCopyCheckpoint,
    jobs: (value: Record<string, unknown>[]) => (jobs = value),
    loseResponse: () => (loseResponse = true),
    terminal: (value: Record<string, unknown>) => (terminal = value),
  };
}

describe('bounded baseline Copy operator', () => {
  test('uses the immutable global window plus outer chunk bounds on shared compute', async () => {
    const f = fixture();
    const result = await runBoundedBaselineCopy(f.tb, f.recovery, f.state(), {});
    expect(result).toEqual(['job-chunk']);
    const copy = f.requests.find((path) => path.includes('/copy?'))!;
    expect(copy).toContain(`start_day=${f.state().startDay}`);
    expect(copy).toContain(`end_day=${f.state().endDay}`);
    expect(copy).toContain(`chunk_start_day=${f.state().plan.chunks[0]!.startDay}`);
    expect(copy).toContain(`chunk_end_day=${f.state().plan.chunks[0]!.endDay}`);
    expect(copy).not.toContain('on_demand_compute');
    expect(f.state()).toMatchObject({ complete: true, completedJobs: [{ jobId: 'job-chunk' }] });
  });

  test('recovers exactly one lost receipt and refuses missing or ambiguous matches', async () => {
    for (const matches of [[], [{ job_id: 'one' }, { job_id: 'two' }]]) {
      const active = checkpoint();
      active.activeJob = { copyAttempt: 123 };
      const f = fixture(active);
      f.jobs(matches);
      await expect(runBoundedBaselineCopy(f.tb, f.recovery, f.state(), {})).rejects.toThrow(
        'duplicate submission refused',
      );
      expect(f.requests.filter((path) => path.includes('/copy?'))).toHaveLength(0);
      expect(f.state().activeJob).toEqual({ copyAttempt: 123 });
      const query = f.queries.find((value) => value.includes('tinybird.jobs_log'))!;
      expect(query).toContain("job_type IN ('copy','copy_from_branch')");
      expect(query).toContain("'chunk_start_day'");
      expect(query).toContain("'chunk_end_day'");
      expect(query).toContain("'_mode')='append'");
    }
  });

  test('leaves terminal partial failures active and never submits another chunk', async () => {
    const active = checkpoint();
    active.activeJob = { copyAttempt: 123, jobId: 'job-error' };
    const f = fixture(active);
    f.terminal({ job_id: 'job-error', status: 'error', error: 'private provider error' });
    await expect(runBoundedBaselineCopy(f.tb, f.recovery, f.state(), {})).rejects.toThrow(
      'terminal status error',
    );
    expect(f.state().activeJob).toEqual({ copyAttempt: 123, jobId: 'job-error' });
    expect(f.calls).not.toContain('completeBoundedBaselineCopyChunk');
    expect(f.requests.filter((path) => path.includes('/copy?'))).toHaveLength(0);
  });

  test('clips retained source proof by UTC day while keeping the original Copy window', async () => {
    const retained = retainedMigrationWindow();
    const previous = new Date(`${retained.startDay}T00:00:00.000Z`);
    previous.setUTCDate(previous.getUTCDate() - 1);
    const previousDay = previous.toISOString().slice(0, 10);
    const full = { startDay: previousDay, endDay: retained.startDay };
    const proof = {
      category: 'tool_events' as const,
      rows: 3,
      days: [previousDay, retained.startDay],
      dailyStats: [
        { day: previousDay, rows: 1, projectedBytes: 10 },
        { day: retained.startDay, rows: 2, projectedBytes: 20 },
      ],
    };
    const bounded: BoundedBaselineCopyCheckpoint = {
      mode: 'bounded',
      category: proof.category,
      ...full,
      startedAt: 1,
      plan: buildBaselineCopyPlan(proof, full),
      completedJobs: [],
      complete: false,
    };
    const queries: string[] = [];
    const tb = {
      async sql(query: string) {
        queries.push(query);
        return { data: [{ rows: 2, projected_bytes: 20 }], meta: [] };
      },
    } as unknown as AgentTinybirdClient;
    const recovery = { org: 'org-proof' } as AgentRecoveryClient;
    await expect(verifyChunkSource(tb, recovery, bounded, bounded.plan.chunks[0]!)).resolves.toBe(
      2,
    );
    expect(queries[0]).toContain(`toDateTime('${bounded.startDay}')`);
    expect(queries[0]).toContain(`toDateTime('${retained.startDay}')`);
  });

  test('ignores physically lingering TTL rows for a fully expired chunk', async () => {
    const full = { startDay: '2020-01-01', endDay: '2020-01-01' };
    const proof = {
      category: 'tool_events' as const,
      rows: 1,
      days: [full.startDay],
      dailyStats: [{ day: full.startDay, rows: 1, projectedBytes: 10 }],
    };
    const bounded: BoundedBaselineCopyCheckpoint = {
      mode: 'bounded',
      category: proof.category,
      ...full,
      startedAt: 1,
      plan: buildBaselineCopyPlan(proof, full),
      completedJobs: [],
      complete: false,
    };
    const tb = {
      async sql() {
        throw new Error('expired physical rows must not be queried');
      },
    } as unknown as AgentTinybirdClient;
    const recovery = { org: 'org-proof' } as AgentRecoveryClient;
    await expect(verifyChunkSource(tb, recovery, bounded, bounded.plan.chunks[0]!)).resolves.toBe(
      0,
    );
    await expect(
      verifyCompletedChunkTarget(tb, recovery, bounded, bounded.plan.chunks[0]!),
    ).resolves.toBeUndefined();
  });

  test('rejects malformed Tinybird aggregates instead of coercing them to zero', async () => {
    const bounded = checkpoint();
    for (const value of [null, '', false, undefined]) {
      const tb = {
        async sql() {
          return { data: [{ rows: value, projected_bytes: value }], meta: [] };
        },
      } as unknown as AgentTinybirdClient;
      await expect(
        verifyChunkSource(
          tb,
          { org: 'org-proof' } as AgentRecoveryClient,
          bounded,
          bounded.plan.chunks[0]!,
        ),
      ).rejects.toThrow('Invalid bounded baseline retained source rows');
    }
    const tb = {
      async sql() {
        return { data: [{ rows: 0, projected_bytes: null }], meta: [] };
      },
    } as unknown as AgentTinybirdClient;
    await expect(
      verifyChunkSource(
        tb,
        { org: 'org-proof' } as AgentRecoveryClient,
        bounded,
        bounded.plan.chunks[0]!,
      ),
    ).rejects.toThrow('Invalid bounded baseline retained source bytes');
  });
});
