import { env as workerEnv } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { AgentFactBatcherInstance } from '../fact-batcher';
import {
  baselineCopyCheckpoint,
  baselineMigrationWindow,
  beginBaselineCopy,
  beginBaselineMigrationWindow,
  confirmBaselineCopy,
  retryBaselineCopy,
} from '../baseline-copy-migration';

const env = workerEnv as unknown as {
  AGENT_FACT_BATCHER: DurableObjectNamespace<AgentFactBatcherInstance>;
};
const intent = {
  category: 'messages' as const,
  startDay: '2025-09-13',
  endDay: '2026-09-13',
  startedAt: 1789326000000,
  copyAttempt: 1789326000000,
};

describe('baseline Copy durability', () => {
  it('reuses one migration-wide window after the retained day changes', async () => {
    const host = env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
    await runInDurableObject(host, async (_instance, state) => {
      const first = { startDay: '2025-09-13', endDay: '2026-09-13' };
      expect(await beginBaselineMigrationWindow(state.storage, first)).toEqual(first);
      expect(
        await beginBaselineMigrationWindow(state.storage, {
          startDay: '2025-09-14',
          endDay: '2026-09-14',
        }),
      ).toEqual(first);
      expect(await baselineMigrationWindow(state.storage)).toEqual(first);
    });
  });

  it('grants a single start and preserves an unknown outcome through retries', async () => {
    const host = env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
    await runInDurableObject(host, async (_instance, state) => {
      expect(await beginBaselineCopy(state.storage, intent)).toMatchObject({
        created: true,
        complete: false,
      });
      expect(
        await beginBaselineCopy(state.storage, { ...intent, startedAt: intent.startedAt + 1 }),
      ).toMatchObject({ created: false, startedAt: intent.startedAt });
    });
    await runInDurableObject(host, async (_instance, state) => {
      expect(await baselineCopyCheckpoint(state.storage, 'messages')).toEqual({
        ...intent,
        complete: false,
      });
      await expect(
        beginBaselineCopy(state.storage, { ...intent, startDay: '2025-09-14' }),
      ).rejects.toThrow('window changed');
      expect(
        await confirmBaselineCopy(state.storage, {
          category: 'messages',
          copyAttempt: intent.copyAttempt,
          jobId: 'job-1',
          complete: false,
        }),
      ).toMatchObject({ jobId: 'job-1', complete: false });
      await expect(
        confirmBaselineCopy(state.storage, {
          category: 'messages',
          copyAttempt: intent.copyAttempt,
          jobId: 'job-2',
          complete: true,
        }),
      ).rejects.toThrow('conflict');
      expect(
        await confirmBaselineCopy(state.storage, {
          category: 'messages',
          copyAttempt: intent.copyAttempt,
          jobId: 'job-1',
          complete: true,
        }),
      ).toMatchObject({ complete: true });
      expect(
        await confirmBaselineCopy(state.storage, {
          category: 'messages',
          copyAttempt: intent.copyAttempt,
          jobId: 'job-1',
          complete: false,
        }),
      ).toMatchObject({ complete: true });
    });
  });

  it('arms one retry with an exact old-job compare-and-swap and preserves the window', async () => {
    const host = env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
    await runInDurableObject(host, async (_instance, state) => {
      await beginBaselineCopy(state.storage, intent);
      await confirmBaselineCopy(state.storage, {
        category: 'messages',
        copyAttempt: intent.copyAttempt,
        jobId: 'job-failed',
        complete: false,
      });
      const proof = {
        category: 'messages' as const,
        expectedJobId: 'job-failed',
        expectedCopyAttempt: intent.copyAttempt,
        nextCopyAttempt: intent.copyAttempt + 1,
        observedAt: intent.startedAt + 1,
        providerErrorSha256: 'a'.repeat(64),
        journalSha256: 'b'.repeat(64),
      };
      await expect(retryBaselineCopy(state.storage, proof)).resolves.toEqual({
        ...intent,
        copyAttempt: intent.copyAttempt + 1,
        failedAttempt: {
          copyAttempt: intent.copyAttempt,
          jobId: 'job-failed',
          status: 'error',
          observedAt: intent.startedAt + 1,
          providerErrorSha256: 'a'.repeat(64),
          journalSha256: 'b'.repeat(64),
        },
        complete: false,
      });
      await expect(retryBaselineCopy(state.storage, proof)).rejects.toThrow('retry conflict');
      await expect(
        confirmBaselineCopy(state.storage, {
          category: 'messages',
          copyAttempt: intent.copyAttempt,
          jobId: 'job-failed',
          complete: true,
        }),
      ).rejects.toThrow('confirmation conflict');
      await expect(
        confirmBaselineCopy(state.storage, {
          category: 'messages',
          copyAttempt: intent.copyAttempt + 1,
          jobId: 'job-retry',
          complete: false,
        }),
      ).resolves.toMatchObject({ jobId: 'job-retry', copyAttempt: intent.copyAttempt + 1 });
      await expect(
        retryBaselineCopy(state.storage, {
          ...proof,
          expectedJobId: 'another-job',
          nextCopyAttempt: intent.copyAttempt + 2,
        }),
      ).rejects.toThrow('retry conflict');
    });
  });

  it('never retries a completed checkpoint or a failed dedicated attempt', async () => {
    const completed = env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
    await runInDurableObject(completed, async (_instance, state) => {
      await beginBaselineCopy(state.storage, intent);
      await confirmBaselineCopy(state.storage, {
        category: 'messages',
        copyAttempt: intent.copyAttempt,
        jobId: 'job-done',
        complete: true,
      });
      await expect(
        retryBaselineCopy(state.storage, {
          category: 'messages',
          expectedJobId: 'job-done',
          expectedCopyAttempt: intent.copyAttempt,
          nextCopyAttempt: intent.copyAttempt + 1,
          observedAt: intent.startedAt + 1,
          providerErrorSha256: 'a'.repeat(64),
          journalSha256: 'b'.repeat(64),
        }),
      ).rejects.toThrow('retry conflict');
    });

    const retried = env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
    await runInDurableObject(retried, async (_instance, state) => {
      await state.storage.put('baseline-copy:messages', {
        ...intent,
        copyAttempt: intent.copyAttempt + 1,
        jobId: 'job-retry-failed',
        failedAttempt: {
          copyAttempt: intent.copyAttempt,
          jobId: 'job-first-failed',
          status: 'error',
          observedAt: intent.startedAt + 1,
          providerErrorSha256: 'a'.repeat(64),
          journalSha256: 'b'.repeat(64),
        },
        complete: false,
      });
      await expect(
        retryBaselineCopy(state.storage, {
          category: 'messages',
          expectedJobId: 'job-retry-failed',
          expectedCopyAttempt: intent.copyAttempt + 1,
          nextCopyAttempt: intent.copyAttempt + 2,
          observedAt: intent.startedAt + 2,
          providerErrorSha256: 'c'.repeat(64),
          journalSha256: 'd'.repeat(64),
        }),
      ).rejects.toThrow('retry conflict');
    });
  });
});
