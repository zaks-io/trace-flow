import { env as workerEnv } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { sha256Hex } from '@trace-flow/utils';
import { describe, expect, it } from 'vitest';
import type { AgentFactBatcherInstance } from '../fact-batcher';
import type { BaselineCopyPlan } from '../baseline-copy-contract';
import {
  armBoundedBaselineCopyChunk,
  beginBoundedBaselineCopy,
  completeBoundedBaselineCopy,
  completeBoundedBaselineCopyChunk,
  confirmBoundedBaselineCopyChunk,
} from '../bounded-baseline-copy';
import { baselineCopyPlanHashInput } from '../baseline-copy-plan';
import {
  beginBaselineCopy,
  confirmBaselineCopy,
  retryBaselineCopy,
} from '../baseline-copy-migration';

const env = workerEnv as unknown as {
  AGENT_FACT_BATCHER: DurableObjectNamespace<AgentFactBatcherInstance>;
};
const window = { startDay: '2026-09-01', endDay: '2026-09-10' };
const base = { category: 'tool_events' as const, ...window, startedAt: 100 };

async function plan(): Promise<BaselineCopyPlan> {
  const value: BaselineCopyPlan = {
    sha256: '0'.repeat(64),
    dailyStats: [
      { day: '2026-09-01', rows: 10, projectedBytes: 100 },
      { day: '2026-09-02', rows: 20, projectedBytes: 200 },
      { day: '2026-09-09', rows: 30, projectedBytes: 300 },
    ],
    chunks: [
      { startDay: '2026-09-01', endDay: '2026-09-02', rows: 30, projectedBytes: 300 },
      { startDay: '2026-09-09', endDay: '2026-09-09', rows: 30, projectedBytes: 300 },
    ],
    totalRows: 60,
    totalProjectedBytes: 600,
  };
  value.sha256 = await sha256Hex(
    baselineCopyPlanHashInput(base.category, window.startDay, window.endDay, value),
  );
  return value;
}

function chunkInput(planSha256: string, copyAttempt = 101, chunkIndex = 0) {
  return { category: base.category, planSha256, chunkIndex, copyAttempt };
}

describe('bounded baseline Copy checkpoint', () => {
  it('serializes concurrent intents and rejects stale runners', async () => {
    const host = env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
    const copyPlan = await plan();
    await runInDurableObject(host, async (_instance, state) => {
      await expect(
        beginBoundedBaselineCopy(state.storage, { ...base, plan: copyPlan }),
      ).resolves.toMatchObject({ mode: 'bounded', created: true, completedJobs: [] });
      const intents = await Promise.all([
        armBoundedBaselineCopyChunk(state.storage, chunkInput(copyPlan.sha256)),
        armBoundedBaselineCopyChunk(state.storage, chunkInput(copyPlan.sha256)),
      ]);
      expect(intents.map((intent) => intent.created).sort()).toEqual([false, true]);
      await expect(
        armBoundedBaselineCopyChunk(state.storage, chunkInput(copyPlan.sha256, 102)),
      ).rejects.toThrow('intent conflict');
      await expect(
        armBoundedBaselineCopyChunk(state.storage, chunkInput(copyPlan.sha256, 101, 1)),
      ).rejects.toThrow('cursor conflict');
      await expect(
        confirmBoundedBaselineCopyChunk(state.storage, {
          ...chunkInput(copyPlan.sha256, 102),
          jobId: 'stale-job',
        }),
      ).rejects.toThrow('receipt conflict');
      for (const jobId of [undefined, null]) {
        await expect(
          confirmBoundedBaselineCopyChunk(state.storage, {
            ...chunkInput(copyPlan.sha256),
            jobId,
          } as never),
        ).rejects.toThrow('Invalid bounded baseline Copy job receipt');
      }
    });
  });

  it('resumes completed chunks in order and fences stale legacy confirmation', async () => {
    const host = env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
    const copyPlan = await plan();
    await runInDurableObject(host, async (_instance, state) => {
      await beginBoundedBaselineCopy(state.storage, { ...base, plan: copyPlan });
      const first = chunkInput(copyPlan.sha256);
      await armBoundedBaselineCopyChunk(state.storage, first);
      await confirmBoundedBaselineCopyChunk(state.storage, { ...first, jobId: 'job-one' });
      const completed = await completeBoundedBaselineCopyChunk(state.storage, {
        ...first,
        jobId: 'job-one',
      });
      expect(completed).toMatchObject({ completedJobs: [{ copyAttempt: 101, jobId: 'job-one' }] });
      expect(completed.activeJob).toBeUndefined();
      await expect(
        completeBoundedBaselineCopyChunk(state.storage, { ...first, jobId: 'job-one' }),
      ).resolves.toEqual(completed);
      await expect(
        confirmBaselineCopy(state.storage, {
          category: base.category,
          copyAttempt: 101,
          jobId: 'job-one',
          complete: true,
        }),
      ).rejects.toThrow('forbidden in bounded mode');
      await expect(
        retryBaselineCopy(state.storage, {
          category: base.category,
          expectedJobId: 'job-one',
          expectedCopyAttempt: 101,
          nextCopyAttempt: 102,
          observedAt: 102,
          providerErrorSha256: 'a'.repeat(64),
          journalSha256: 'b'.repeat(64),
        }),
      ).rejects.toThrow('retry conflict');

      const second = chunkInput(copyPlan.sha256, 103, 1);
      await armBoundedBaselineCopyChunk(state.storage, second);
      await confirmBoundedBaselineCopyChunk(state.storage, { ...second, jobId: 'job-two' });
      await completeBoundedBaselineCopyChunk(state.storage, { ...second, jobId: 'job-two' });
      await expect(
        completeBoundedBaselineCopy(state.storage, {
          category: base.category,
          planSha256: copyPlan.sha256,
          proofSha256: 'c'.repeat(64),
          completedAt: 104,
        }),
      ).resolves.toMatchObject({
        complete: true,
        completion: { lastJobId: 'job-two', proofSha256: 'c'.repeat(64) },
      });
    });
  });

  it('archives both failed whole-window receipts without completing either', async () => {
    const host = env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
    const copyPlan = await plan();
    await runInDurableObject(host, async (_instance, state) => {
      await state.storage.put('baseline-copy:tool_events', {
        ...base,
        copyAttempt: 11,
        jobId: 'dedicated-failed',
        complete: false,
        failedAttempt: {
          copyAttempt: 10,
          jobId: 'original-failed',
          status: 'error',
          observedAt: 10,
          providerErrorSha256: 'a'.repeat(64),
          journalSha256: 'b'.repeat(64),
        },
      });
      const transitioned = await beginBoundedBaselineCopy(state.storage, {
        ...base,
        plan: copyPlan,
        legacyFailure: {
          expectedJobId: 'dedicated-failed',
          expectedCopyAttempt: 11,
          observedAt: 12,
          providerErrorSha256: 'c'.repeat(64),
          journalSha256: 'd'.repeat(64),
        },
      });
      expect(transitioned.complete).toBe(false);
      expect(transitioned.completedJobs).toEqual([]);
      expect(transitioned.legacy).toMatchObject({
        checkpoint: {
          jobId: 'dedicated-failed',
          complete: false,
          failedAttempt: { jobId: 'original-failed', status: 'error' },
        },
        currentFailure: { jobId: 'dedicated-failed', status: 'error' },
      });
      await expect(beginBaselineCopy(state.storage, { ...base, copyAttempt: 12 })).rejects.toThrow(
        'cannot replace bounded mode',
      );
    });
  });

  it('rejects invalid coverage, bounds, totals, hashes, and extra input fields', async () => {
    const host = env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
    const copyPlan = await plan();
    await runInDurableObject(host, async (_instance, state) => {
      for (const invalid of [
        { ...copyPlan, totalRows: 61 },
        { ...copyPlan, chunks: [copyPlan.chunks[0]!] },
        {
          ...copyPlan,
          chunks: [
            { ...copyPlan.chunks[0]!, projectedBytes: 65 * 1024 * 1024 },
            copyPlan.chunks[1]!,
          ],
        },
      ]) {
        await expect(
          beginBoundedBaselineCopy(state.storage, { ...base, plan: invalid }),
        ).rejects.toThrow(/totals|omits|chunk/);
      }
      await expect(
        beginBoundedBaselineCopy(state.storage, {
          ...base,
          plan: copyPlan,
          unexpected: 'provider payload',
        } as never),
      ).rejects.toThrow('unexpected fields');
      await expect(
        beginBoundedBaselineCopy(state.storage, {
          ...base,
          plan: { ...copyPlan, sha256: 'f'.repeat(64) },
        }),
      ).rejects.toThrow('plan hash mismatch');
    });
  });
});
