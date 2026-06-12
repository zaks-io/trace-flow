import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env as workerEnv } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import type { AgentFactBatcherInstance } from '../fact-batcher';
import { AGENT_FACT_BATCHER_FLUSH_INTERVAL_MS } from '../fact-batcher';

vi.mock('@trace-flow/tinybird-client', () => ({
  insertRows: vi.fn().mockResolvedValue(undefined),
}));

const env = workerEnv as unknown as {
  AGENT_FACT_BATCHER: DurableObjectNamespace<AgentFactBatcherInstance>;
};

const sparseBatch = {
  rows: {
    messages: [{ OrgId: 'org-1', session_pk: 'session-1', message_pk: 'message-1' }],
    tool_events: [],
    file_events: [],
    capability_snapshots: [],
    pull_request_links: [],
  },
};

describe('AgentFactBatcher logic', () => {
  let batcher: DurableObjectStub<AgentFactBatcherInstance>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    const id = env.AGENT_FACT_BATCHER.newUniqueId();
    batcher = env.AGENT_FACT_BATCHER.get(id);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for the low-volume flush interval before flushing sparse facts', async () => {
    vi.useRealTimers();

    const scheduled = await runInDurableObject(
      batcher,
      async (instance: AgentFactBatcherInstance, state) => {
        const before = Date.now();
        await instance.addFacts(sparseBatch);
        const scheduledAlarm = await state.storage.getAlarm();
        const after = Date.now();
        await state.storage.deleteAlarm();
        return { after, before, alarm: scheduledAlarm };
      },
    );

    expect(scheduled.alarm).toBeGreaterThanOrEqual(
      scheduled.before + AGENT_FACT_BATCHER_FLUSH_INTERVAL_MS,
    );
    expect(scheduled.alarm).toBeLessThanOrEqual(
      scheduled.after + AGENT_FACT_BATCHER_FLUSH_INTERVAL_MS,
    );
  });
});
