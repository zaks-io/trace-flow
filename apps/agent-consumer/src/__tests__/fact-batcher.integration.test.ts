import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env as workerEnv } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { insertRows } from '@trace-flow/tinybird-client';
import type { AgentFactBatcherInstance } from '../fact-batcher';
import { AGENT_FACT_BATCHER_FLUSH_INTERVAL_MS } from '../fact-batcher';
import { batchContext, toolEventRow } from '../rows';
import { queueMessage, toolEventFact } from './factories';

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
    review_unit_attributions: [],
  },
};

const emptyBatchRows = {
  messages: [],
  tool_events: [],
  file_events: [],
  capability_snapshots: [],
  pull_request_links: [],
  review_unit_attributions: [],
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
    vi.clearAllMocks();
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

  it('normalizes pre-rollout pending tool event rows before flushing', async () => {
    const row = toolEventRow(batchContext(queueMessage()), toolEventFact({ status: 'failure' }));
    const pendingRow = { ...row } as Record<string, unknown>;
    delete pendingRow.error_category;
    delete pendingRow.error_category_coverage;
    delete pendingRow.is_navigation;
    delete pendingRow.navigation_kind;
    delete pendingRow.navigation_hint_coverage;
    delete pendingRow.navigation_path_hint;
    delete pendingRow.navigation_pattern_hint;

    await runInDurableObject(batcher, async (instance: AgentFactBatcherInstance) => {
      await instance.addFacts({
        rows: {
          ...emptyBatchRows,
          tool_events: [pendingRow],
        },
      });
      await instance.alarm();
    });

    expect(insertRows).toHaveBeenCalledOnce();
    const [flushedRows, , datasource] = vi.mocked(insertRows).mock.calls[0] ?? [];
    expect(datasource).toBe('agent_tool_event_facts');
    expect(flushedRows).toEqual([
      expect.objectContaining({
        error_category: 'unknown',
        error_category_coverage: 'unknown',
        is_navigation: 0,
        navigation_kind: 'none',
        navigation_hint_coverage: 'unknown',
        navigation_path_hint: '',
        navigation_pattern_hint: '',
      }),
    ]);
  });
});
