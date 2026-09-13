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
          jobId: 'job-1',
          complete: false,
        }),
      ).toMatchObject({ jobId: 'job-1', complete: false });
      await expect(
        confirmBaselineCopy(state.storage, {
          category: 'messages',
          jobId: 'job-2',
          complete: true,
        }),
      ).rejects.toThrow('conflict');
      expect(
        await confirmBaselineCopy(state.storage, {
          category: 'messages',
          jobId: 'job-1',
          complete: true,
        }),
      ).toMatchObject({ complete: true });
      expect(
        await confirmBaselineCopy(state.storage, {
          category: 'messages',
          jobId: 'job-1',
          complete: false,
        }),
      ).toMatchObject({ complete: true });
    });
  });
});
