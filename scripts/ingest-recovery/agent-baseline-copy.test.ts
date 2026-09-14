import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBaselineCopy } from './agent-baseline-copy';
import {
  AgentTinybirdRequestError,
  type AgentRecoveryClient,
  type AgentTinybirdClient,
} from './agent-transport';
import type { LegacyBaselineCopyCheckpoint } from '../../apps/agent-consumer/src/baseline-copy-contract';

const window = { startDay: '2026-09-01', endDay: '2026-09-13' };
const originalFetch = globalThis.fetch;
const originalAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const originalApiToken = process.env.CLOUDFLARE_API_TOKEN;
let guardRequests: string[] = [];

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
  guardRequests = [];
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  restoreEnvironment('CLOUDFLARE_ACCOUNT_ID', originalAccountId);
  restoreEnvironment('CLOUDFLARE_API_TOKEN', originalApiToken);
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const failedJobRow = JSON.parse(
  readFileSync(new URL('./fixtures/tinybird-copy-error-job.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
function fixture(initial: LegacyBaselineCopyCheckpoint | null = null) {
  let checkpoint = initial;
  let loseCopyReceipt = false;
  let jobApiExpired = false;
  let jobs: Record<string, unknown>[] = [];
  let targetRows = 0;
  let proofOverrides: Record<string, unknown> = {};
  const requests: string[] = [];
  const queries: string[] = [];
  let boundedInput: Record<string, unknown> | undefined;
  const jobDetails = new Map<string, Record<string, unknown>>([
    ['job-one', { job_id: 'job-one', status: 'done' }],
    ['job-old', { job_id: 'job-old', status: 'done' }],
    ['job-retry', { job_id: 'job-retry', status: 'done' }],
    [
      'job-failed',
      {
        job_id: 'job-failed',
        kind: 'copy',
        status: 'error',
        pipe_name: 'repair_agent_tool_events_versions_baseline',
        error: 'Copy timed out',
        query_sql: 'private provider SQL',
      },
    ],
  ]);
  const recovery = {
    org: 'org-proof',
    async call(method: string, input: Record<string, unknown>) {
      if (method === 'getBaselineCopy') return checkpoint;
      if (method === 'beginBoundedBaselineCopy') {
        boundedInput = input;
        throw new Error('bounded transition armed');
      }
      if (method === 'beginBaselineCopy') {
        checkpoint = { ...input, complete: false } as unknown as LegacyBaselineCopyCheckpoint;
        return { ...checkpoint, created: true };
      }
      if (method === 'confirmBaselineCopy') {
        if (
          checkpoint?.copyAttempt !== input.copyAttempt ||
          (checkpoint.jobId && checkpoint.jobId !== input.jobId)
        ) {
          throw new Error('confirmation conflict');
        }
        checkpoint = { ...checkpoint, ...input } as LegacyBaselineCopyCheckpoint;
        return checkpoint;
      }
      if (method === 'retryBaselineCopy') {
        if (
          checkpoint?.complete ||
          checkpoint?.failedAttempt ||
          checkpoint?.jobId !== input.expectedJobId ||
          checkpoint.copyAttempt !== input.expectedCopyAttempt
        ) {
          throw new Error('retry conflict');
        }
        const { jobId, ...preserved } = checkpoint;
        checkpoint = {
          ...preserved,
          copyAttempt: input.nextCopyAttempt as number,
          complete: false,
          failedAttempt: {
            copyAttempt: input.expectedCopyAttempt,
            jobId,
            status: 'error',
            observedAt: input.observedAt as number,
            providerErrorSha256: input.providerErrorSha256 as string,
            journalSha256: input.journalSha256 as string,
          },
        };
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
        const jobId = path.slice('/v0/jobs/'.length);
        return jobDetails.get(jobId) ?? { job_id: jobId, status: 'done' };
      }
      if (loseCopyReceipt) throw new Error('Connection lost after submission');
      return {
        job: { job_id: path.includes('on_demand_compute=true') ? 'job-retry' : 'job-one' },
      };
    },
    async sql(query: string) {
      queries.push(query);
      if (query.includes(' AS target_rows')) {
        return {
          data: [
            {
              ...failedJobRow,
              target_rows: targetRows,
              ...proofOverrides,
            },
          ],
          meta: [],
        };
      }
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
    get boundedInput() {
      return boundedInput;
    },
    loseReceipt() {
      loseCopyReceipt = true;
    },
    expireJobApi() {
      jobApiExpired = true;
    },
    jobs(value: Record<string, unknown>[]) {
      jobs = value;
    },
    setJob(jobId: string, details: Record<string, unknown>) {
      jobDetails.set(jobId, { job_id: jobId, ...details });
    },
    setTargetRows(rows: number) {
      targetRows = rows;
    },
    setProof(overrides: Record<string, unknown>) {
      proofOverrides = overrides;
    },
  };
}

const retryJournal = () => mkdtempSync(join(tmpdir(), 'baseline-copy-retry-'));

const toolProof = () => ({
  category: 'tool_events' as const,
  rows: 1,
  days: [window.startDay],
  dailyStats: [{ day: window.startDay, rows: 1, projectedBytes: 10 }],
});

describe('baseline Copy restart safety', () => {
  test('reads only verified tinybird.jobs_log columns for failed-job proof', async () => {
    expect(Object.keys(failedJobRow).sort()).toEqual([
      'created_at',
      'datasource_id',
      'error',
      'job_id',
      'job_metadata',
      'job_type',
      'pipe_id',
      'request_id',
      'started_at',
      'status',
      'updated_at',
      'workspace_id',
    ]);
    const journal = retryJournal();
    try {
      const f = fixture({
        category: 'tool_events',
        ...window,
        startedAt: 1,
        copyAttempt: 1,
        jobId: 'job-failed',
        complete: false,
      });
      await expect(
        runBaselineCopy(f.tb, f.recovery, 'tool_events', window, {
          retryJournalRoot: journal,
          sourceProof: toolProof(),
        }),
      ).rejects.toThrow('bounded transition armed');
      const query = f.queries.find((candidate) => candidate.includes(' AS target_rows'))!;
      expect(query).toContain('job_metadata');
      expect(query).not.toMatch(/^\s+pipe_name,/m);
    } finally {
      rmSync(journal, { recursive: true });
    }
  });

  test('a completed Copy is reused without writing again', async () => {
    const f = fixture({
      category: 'messages',
      ...window,
      startedAt: 1,
      copyAttempt: 1,
      jobId: 'job-one',
      complete: true,
    });
    expect(await runBaselineCopy(f.tb, f.recovery, 'messages', window)).toEqual(['job-one']);
    expect(f.checkpoint?.complete).toBe(true);
    const count = f.requests.length;
    await runBaselineCopy(f.tb, f.recovery, 'messages', window);
    expect(f.requests).toHaveLength(count);
  });
  test('an unresolved durable intent never causes a blind duplicate Copy', async () => {
    const f = fixture({
      category: 'messages',
      ...window,
      startedAt: 1,
      copyAttempt: 1,
      complete: false,
    });
    await expect(runBaselineCopy(f.tb, f.recovery, 'messages', window)).rejects.toThrow(
      'unresolved',
    );
    expect(f.checkpoint?.jobId).toBeUndefined();
    await expect(runBaselineCopy(f.tb, f.recovery, 'messages', window)).rejects.toThrow(
      'unresolved',
    );
    expect(f.requests).toHaveLength(0);
    f.jobs([{ job_id: 'job-recovered', status: 'done' }]);
    expect(await runBaselineCopy(f.tb, f.recovery, 'messages', window)).toEqual(['job-recovered']);
    expect(f.checkpoint?.complete).toBe(true);
    expect(f.requests.filter((path) => path.includes('/copy?'))).toHaveLength(0);
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

    expect(await runBaselineCopy(f.tb, f.recovery, 'messages', window)).toEqual(['job-old']);
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

  test('transitions a verified failed whole-window job to a bounded plan without another whole Copy', async () => {
    const journal = retryJournal();
    try {
      const f = fixture({
        category: 'tool_events',
        ...window,
        startedAt: 1,
        copyAttempt: 1,
        jobId: 'job-failed',
        complete: false,
      });
      const sourceProof = toolProof();
      await expect(
        runBaselineCopy(f.tb, f.recovery, 'tool_events', window, {
          retryJournalRoot: journal,
          sourceProof,
        }),
      ).rejects.toThrow('bounded transition armed');
      expect(f.requests.filter((path) => path.includes('/copy?'))).toHaveLength(0);
      expect(f.boundedInput).toMatchObject({
        category: 'tool_events',
        startDay: window.startDay,
        endDay: window.endDay,
        legacyFailure: { expectedJobId: 'job-failed', expectedCopyAttempt: 1 },
      });
      expect(readdirSync(journal)).toEqual(['tool_events-job-failed.json']);
      expect(readFileSync(join(journal, 'tool_events-job-failed.json'), 'utf8')).toContain(
        'private provider SQL',
      );
      expect(guardRequests.filter((url) => url.includes('collector.trace-flow.dev'))).toHaveLength(
        2,
      );
      expect(f.queries.find((query) => query.includes(' AS target_rows'))).toContain(
        'FROM agent_tool_event_fact_versions FINAL WHERE OrgId',
      );
    } finally {
      rmSync(journal, { recursive: true });
    }
  });

  test('refuses terminal non-error jobs, nonempty targets, and mismatched failed metadata', async () => {
    const cancelled = fixture({
      category: 'tool_events',
      ...window,
      startedAt: 1,
      copyAttempt: 1,
      jobId: 'job-cancelled',
      complete: false,
    });
    cancelled.setJob('job-cancelled', { status: 'cancelled' });
    await expect(
      runBaselineCopy(cancelled.tb, cancelled.recovery, 'tool_events', window),
    ).rejects.toThrow('terminal status cancelled; retry refused');

    const journal = retryJournal();
    try {
      const populated = fixture({
        category: 'tool_events',
        ...window,
        startedAt: 1,
        copyAttempt: 1,
        jobId: 'job-failed',
        complete: false,
      });
      populated.setTargetRows(1);
      await expect(
        runBaselineCopy(populated.tb, populated.recovery, 'tool_events', window, {
          retryJournalRoot: journal,
          sourceProof: toolProof(),
        }),
      ).rejects.toThrow('empty organization category target');

      const mismatch = fixture({
        category: 'tool_events',
        ...window,
        startedAt: 1,
        copyAttempt: 1,
        jobId: 'job-failed',
        complete: false,
      });
      mismatch.setProof({
        job_metadata: JSON.stringify({
          ...JSON.parse(failedJobRow.job_metadata as string),
          parameters: {
            ...JSON.parse(failedJobRow.job_metadata as string).parameters,
            copy_attempt: '2',
          },
        }),
      });
      await expect(
        runBaselineCopy(mismatch.tb, mismatch.recovery, 'tool_events', window, {
          retryJournalRoot: journal,
          sourceProof: toolProof(),
        }),
      ).rejects.toThrow('does not match its durable intent');
      expect(populated.requests.filter((path) => path.includes('/copy?'))).toHaveLength(0);
      expect(mismatch.requests.filter((path) => path.includes('/copy?'))).toHaveLength(0);
    } finally {
      rmSync(journal, { recursive: true });
    }
  });

  test('preserves the original failed attempt when transitioning a second failed receipt', async () => {
    const journal = retryJournal();
    try {
      const f = fixture({
        category: 'tool_events',
        ...window,
        startedAt: 1,
        copyAttempt: 2,
        jobId: 'job-failed',
        failedAttempt: {
          copyAttempt: 1,
          jobId: 'job-original',
          status: 'error',
          observedAt: 2,
          providerErrorSha256: 'a'.repeat(64),
          journalSha256: 'b'.repeat(64),
        },
        complete: false,
      });
      f.setProof({
        job_metadata: JSON.stringify({
          ...JSON.parse(failedJobRow.job_metadata as string),
          parameters: {
            ...JSON.parse(failedJobRow.job_metadata as string).parameters,
            copy_attempt: '2',
          },
        }),
      });
      await expect(
        runBaselineCopy(f.tb, f.recovery, 'tool_events', window, {
          retryJournalRoot: journal,
          sourceProof: toolProof(),
        }),
      ).rejects.toThrow('bounded transition armed');
      expect(f.checkpoint?.failedAttempt?.jobId).toBe('job-original');
      expect(f.boundedInput).toMatchObject({
        legacyFailure: { expectedJobId: 'job-failed', expectedCopyAttempt: 2 },
      });
      expect(f.requests.filter((path) => path.includes('/copy?'))).toHaveLength(0);
    } finally {
      rmSync(journal, { recursive: true });
    }
  });
});
