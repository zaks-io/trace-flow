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
import type { BaselineCopyCheckpoint } from '../../apps/agent-consumer/src/baseline-copy-contract';

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
function fixture(initial: BaselineCopyCheckpoint | null = null) {
  let checkpoint = initial;
  let loseCopyReceipt = false;
  let jobApiExpired = false;
  let jobs: Record<string, unknown>[] = [];
  let targetRows = 0;
  let proofOverrides: Record<string, unknown> = {};
  const requests: string[] = [];
  const queries: string[] = [];
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
      if (method === 'beginBaselineCopy') {
        checkpoint = { ...input, complete: false } as unknown as BaselineCopyCheckpoint;
        return { ...checkpoint, created: true };
      }
      if (method === 'confirmBaselineCopy') {
        if (
          checkpoint?.copyAttempt !== input.copyAttempt ||
          (checkpoint.jobId && checkpoint.jobId !== input.jobId)
        ) {
          throw new Error('confirmation conflict');
        }
        checkpoint = { ...checkpoint, ...input } as BaselineCopyCheckpoint;
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
      await runBaselineCopy(f.tb, f.recovery, 'tool_events', window, {
        retryJournalRoot: journal,
      });
      const query = f.queries.find((candidate) => candidate.includes(' AS target_rows'))!;
      expect(query).toContain('job_metadata');
      expect(query).not.toMatch(/^\s+pipe_name,/m);
    } finally {
      rmSync(journal, { recursive: true });
    }
  });

  test('a completed Copy is reused without writing again', async () => {
    const f = fixture();
    expect(await runBaselineCopy(f.tb, f.recovery, 'messages', window)).toBe('job-one');
    expect(f.checkpoint?.complete).toBe(true);
    expect(f.requests[0]).toContain('copy_attempt=');
    expect(f.requests[0]).not.toContain('on_demand_compute');
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

  test('retries one exact failed job on dedicated compute and preserves private evidence', async () => {
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

      expect(
        await runBaselineCopy(f.tb, f.recovery, 'tool_events', window, {
          retryJournalRoot: journal,
        }),
      ).toBe('job-retry');
      const copyRequests = f.requests.filter((path) => path.includes('/copy?'));
      expect(copyRequests).toHaveLength(1);
      expect(copyRequests[0]).toContain('on_demand_compute=true');
      expect(copyRequests[0]).toContain('start_day=2026-09-01');
      expect(copyRequests[0]).toContain('end_day=2026-09-13');
      expect(f.checkpoint).toMatchObject({
        jobId: 'job-retry',
        complete: true,
        failedAttempt: {
          copyAttempt: 1,
          jobId: 'job-failed',
          status: 'error',
        },
      });
      const entries = readdirSync(journal);
      expect(entries).toEqual(['tool_events-job-failed.json']);
      const preserved = readFileSync(join(journal, entries[0]!), 'utf8');
      expect(preserved).toContain('private provider SQL');
      expect(f.checkpoint?.failedAttempt?.journalSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(guardRequests.filter((url) => url.includes('collector.trace-flow.dev'))).toHaveLength(
        2,
      );
      expect(guardRequests.filter((url) => url.includes('/queues?'))).toHaveLength(2);
      expect(f.queries.find((query) => query.includes(' AS target_rows'))).toContain(
        'FROM agent_tool_event_fact_versions FINAL WHERE OrgId',
      );
    } finally {
      rmSync(journal, { recursive: true });
    }
  });

  test('recovers a lost dedicated-compute receipt by the exact new attempt', async () => {
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
      f.loseReceipt();
      await expect(
        runBaselineCopy(f.tb, f.recovery, 'tool_events', window, {
          retryJournalRoot: journal,
        }),
      ).rejects.toThrow('Connection lost');
      const retryAttempt = f.checkpoint!.copyAttempt;
      expect(f.checkpoint?.jobId).toBeUndefined();
      f.jobs([{ job_id: 'job-retry', status: 'done' }]);

      expect(
        await runBaselineCopy(f.tb, f.recovery, 'tool_events', window, {
          retryJournalRoot: journal,
        }),
      ).toBe('job-retry');
      expect(f.requests.filter((path) => path.includes('/copy?'))).toHaveLength(1);
      const recoveryQuery = [...f.queries]
        .reverse()
        .find((query) => query.includes('copy_attempt') && !query.includes(' AS target_rows'));
      expect(recoveryQuery).toContain(`'${retryAttempt}'`);
      expect(f.checkpoint?.failedAttempt?.jobId).toBe('job-failed');
    } finally {
      rmSync(journal, { recursive: true });
    }
  });

  test('refuses terminal non-error jobs and nonempty category targets', async () => {
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
    expect(cancelled.requests.filter((path) => path.includes('/copy?'))).toHaveLength(0);

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
        }),
      ).rejects.toThrow('empty organization category target');
      expect(populated.requests.filter((path) => path.includes('/copy?'))).toHaveLength(0);
    } finally {
      rmSync(journal, { recursive: true });
    }
  });

  test('requires exact failed-job metadata and never retries a second failure', async () => {
    const journal = retryJournal();
    try {
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
        }),
      ).rejects.toThrow('does not match its durable intent');
      expect(mismatch.requests.filter((path) => path.includes('/copy?'))).toHaveLength(0);

      const exhausted = fixture({
        category: 'tool_events',
        ...window,
        startedAt: 1,
        copyAttempt: 2,
        jobId: 'job-retry',
        failedAttempt: {
          copyAttempt: 1,
          jobId: 'job-failed',
          status: 'error',
          observedAt: 2,
          providerErrorSha256: 'a'.repeat(64),
          journalSha256: 'b'.repeat(64),
        },
        complete: false,
      });
      exhausted.setJob('job-retry', { status: 'error', error: 'Retry timed out' });
      await expect(
        runBaselineCopy(exhausted.tb, exhausted.recovery, 'tool_events', window, {
          retryJournalRoot: journal,
        }),
      ).rejects.toThrow('retry limit reached');
      expect(exhausted.requests.filter((path) => path.includes('/copy?'))).toHaveLength(0);
    } finally {
      rmSync(journal, { recursive: true });
    }
  });
});
