import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env as workerEnv } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { insertRows, TinybirdInsertError } from '@trace-flow/tinybird-client';
import type * as TinybirdClient from '@trace-flow/tinybird-client';
import type { AgentFactBatcherInstance } from '../fact-batcher';
import { AGENT_FACT_BATCHER_FLUSH_INTERVAL_MS } from '../fact-batcher';
import { batchContext, toolEventRow } from '../rows';
import { queueMessage, toolEventFact } from './factories';

vi.mock('@trace-flow/tinybird-client', async (importOriginal) => ({
  ...(await importOriginal<typeof TinybirdClient>()),
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

  const flushNow = () =>
    runInDurableObject(batcher, async (instance: AgentFactBatcherInstance, state) => {
      await instance.alarm();
      await state.storage.deleteAlarm();
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

  it('stores the exact normalized tool event payload when delivery is uncertain', async () => {
    const row = toolEventRow(batchContext(queueMessage()), toolEventFact({ status: 'failure' }));
    const pendingRow = { ...row } as Record<string, unknown>;
    delete pendingRow.error_category;
    delete pendingRow.error_category_coverage;
    delete pendingRow.is_navigation;
    delete pendingRow.navigation_kind;
    delete pendingRow.navigation_hint_coverage;
    delete pendingRow.navigation_path_hint;
    delete pendingRow.navigation_pattern_hint;

    vi.mocked(insertRows).mockRejectedValueOnce(new Error('connection closed after request'));
    await runInDurableObject(batcher, async (instance: AgentFactBatcherInstance, state) => {
      await instance.addFacts({ rows: { ...emptyBatchRows, tool_events: [pendingRow] } });
      await state.storage.deleteAlarm();
      await instance.alarm();
      await state.storage.deleteAlarm();
    });

    const page = await runInDurableObject(batcher, (instance: AgentFactBatcherInstance) =>
      instance.listRecovery(),
    );
    expect(page.records[0]).toMatchObject({ classification: 'uncertain', state: 'blocked' });
    const recovered = JSON.parse(page.records[0]?.payload ?? '[]');
    expect(recovered).toEqual(vi.mocked(insertRows).mock.calls[0]?.[0]);
    expect(recovered[0]).toMatchObject({
      error_category: 'unknown',
      error_category_coverage: 'unknown',
      is_navigation: 0,
      navigation_kind: 'none',
      navigation_hint_coverage: 'unknown',
      navigation_path_hint: '',
      navigation_pattern_hint: '',
    });
  });

  it('preserves malformed pending rows as rejected recovery records', async () => {
    await runInDurableObject(batcher, async (instance: AgentFactBatcherInstance, state) => {
      await instance.addFacts(sparseBatch);
      await state.storage.deleteAlarm();
      state.storage.sql.exec(`UPDATE pending_facts SET data = '{malformed'`);
      await instance.alarm();
      await state.storage.deleteAlarm();
    });

    expect(insertRows).not.toHaveBeenCalled();
    const page = await runInDurableObject(batcher, (instance: AgentFactBatcherInstance) =>
      instance.listRecovery(),
    );
    expect(page.records[0]).toMatchObject({ classification: 'rejected', state: 'blocked' });
    expect(page.records[0]?.payload).toBe('[{malformed]');
  });

  it('rejects unsupported legacy-only categories before changing the ledger', async () => {
    const result = await runInDurableObject(
      batcher,
      async (instance: AgentFactBatcherInstance, state) => {
        const outcome = await instance.addFacts({
          rows: {
            ...emptyBatchRows,
            review_unit_attributions: [
              {
                OrgId: 'org-1',
                session_pk: 'session-1',
                review_unit_attribution_pk: 'review-1',
              },
            ],
          },
          writeClean: false,
          writeLegacy: true,
        });
        return {
          outcome,
          ledgerRows: state.storage.sql
            .exec<{ count: number }>('SELECT COUNT(*) AS count FROM fact_ledger')
            .one().count,
          queuedRows: instance.getStats().queuedRows,
        };
      },
    );

    expect(result.outcome.status).toBe('failed');
    expect(result.ledgerRows).toBe(0);
    expect(result.queuedRows).toBe(0);
  });

  it('quarantines uncertain inserts and still flushes later healthy work', async () => {
    vi.mocked(insertRows).mockRejectedValueOnce(new Error('network disconnected'));
    await runInDurableObject(batcher, (instance: AgentFactBatcherInstance) =>
      instance.addFacts(sparseBatch),
    );
    await flushNow();

    const later = {
      rows: {
        ...emptyBatchRows,
        messages: [{ OrgId: 'org-1', session_pk: 'session-2', message_pk: 'message-2' }],
      },
    };
    vi.mocked(insertRows).mockResolvedValueOnce(undefined);
    await runInDurableObject(batcher, (instance: AgentFactBatcherInstance) =>
      instance.addFacts(later),
    );
    await flushNow();

    const stats = await runInDurableObject(batcher, (instance: AgentFactBatcherInstance) =>
      instance.getStats(),
    );
    expect(stats).toMatchObject({
      queuedRows: 0,
      blockedRecoveryRows: 1,
      blockedRecoveryRecords: 1,
    });
    const recovery = await runInDurableObject(batcher, (instance: AgentFactBatcherInstance) =>
      instance.listRecovery(),
    );
    await expect(
      runInDurableObject(batcher, async (instance: AgentFactBatcherInstance, state) => {
        const setAlarm = vi
          .spyOn(state.storage, 'setAlarm')
          .mockRejectedValueOnce(new Error('alarm storage unavailable'));
        try {
          await instance.reconcileRecovery({
            recoveryId: recovery.records[0]!.id,
            action: 'confirm-not-written',
            reason: 'operator verified the row was not written',
          });
        } finally {
          setAlarm.mockRestore();
        }
      }),
    ).rejects.toThrow('alarm storage unavailable');
    expect(
      await runInDurableObject(batcher, (instance: AgentFactBatcherInstance) =>
        instance.getRecovery(recovery.records[0]!.id),
      ),
    ).toMatchObject({ state: 'blocked', resolution: null });
    await expect(
      runInDurableObject(batcher, (instance: AgentFactBatcherInstance) =>
        instance.reconcileRecovery({
          recoveryId: recovery.records[0]!.id,
          action: 'confirm-written',
          reason: '   ',
        }),
      ),
    ).rejects.toThrow('recovery reason is required');
    vi.mocked(insertRows).mockClear();
    const resolved = await runInDurableObject(batcher, (instance: AgentFactBatcherInstance) =>
      instance.reconcileRecovery({
        recoveryId: recovery.records[0]!.id,
        action: 'confirm-written',
        reason: 'operator verified the row exists',
      }),
    );
    await flushNow();
    expect(resolved).toMatchObject({ state: 'resolved', resolution: 'confirm-written' });
    expect(insertRows).not.toHaveBeenCalled();
  });

  it('leaves 429 work healthy for the next alarm retry', async () => {
    await runInDurableObject(batcher, async (instance: AgentFactBatcherInstance, state) => {
      await instance.addFacts(sparseBatch);
      await state.storage.deleteAlarm();
    });
    vi.mocked(insertRows).mockRejectedValueOnce(new TinybirdInsertError(429, 'rate limited'));
    await expect(flushNow()).rejects.toThrow();

    let stats = await runInDurableObject(batcher, (instance: AgentFactBatcherInstance) =>
      instance.getStats(),
    );
    expect(stats).toMatchObject({ queuedRows: 1, blockedRecoveryRecords: 0 });
    vi.mocked(insertRows).mockResolvedValueOnce(undefined);
    await flushNow();
    stats = await runInDurableObject(batcher, (instance: AgentFactBatcherInstance) =>
      instance.getStats(),
    );
    expect(stats.queuedRows).toBe(0);
  });

  it('preserves the complete changed fact for operator reconciliation', async () => {
    await runInDurableObject(batcher, async (instance: AgentFactBatcherInstance, state) => {
      await instance.addFacts(sparseBatch);
      await state.storage.deleteAlarm();
      await instance.addFacts({
        rows: {
          ...emptyBatchRows,
          messages: [
            {
              OrgId: 'org-1',
              session_pk: 'session-1',
              message_pk: 'message-1',
              content: 'changed',
            },
          ],
        },
      });
      await state.storage.deleteAlarm();
    });

    const page = await runInDurableObject(batcher, (instance: AgentFactBatcherInstance) =>
      instance.listRecovery(),
    );
    expect(JSON.parse(page.records[0]?.payload ?? '{}')).toMatchObject({ content: 'changed' });
  });

  it('dedupes repeated repair candidates', async () => {
    const changedBatch = {
      rows: {
        ...emptyBatchRows,
        messages: [
          {
            OrgId: 'org-1',
            session_pk: 'session-1',
            message_pk: 'message-1',
            content: 'changed',
          },
        ],
      },
    };
    await runInDurableObject(batcher, async (instance: AgentFactBatcherInstance, state) => {
      await instance.addFacts(sparseBatch);
      await state.storage.deleteAlarm();
      await instance.addFacts(changedBatch);
      await state.storage.deleteAlarm();
      await instance.addFacts(changedBatch);
      await state.storage.deleteAlarm();
    });

    const result = await runInDurableObject(
      batcher,
      (instance: AgentFactBatcherInstance, state) => ({
        repairs: state.storage.sql
          .exec<{ count: number }>('SELECT COUNT(*) AS count FROM fact_repairs')
          .one().count,
        recovery: instance.listRecovery(),
      }),
    );
    expect(result.repairs).toBe(1);
    expect(result.recovery.records).toHaveLength(1);
  });

  it('retains a multi-megabyte individual fact as rejected without sending it', async () => {
    const content = 'x'.repeat(2_100_000);
    await runInDurableObject(batcher, (instance: AgentFactBatcherInstance) =>
      instance.addFacts({
        rows: {
          ...emptyBatchRows,
          messages: [
            { OrgId: 'org-1', session_pk: 'session-big', message_pk: 'message-big', content },
          ],
        },
      }),
    );
    vi.mocked(insertRows).mockClear();
    await flushNow();

    expect(insertRows).not.toHaveBeenCalled();
    const page = await runInDurableObject(batcher, (instance: AgentFactBatcherInstance) =>
      instance.listRecovery(),
    );
    expect(JSON.parse(page.records[0]?.payload ?? '[]')[0].content).toHaveLength(2_100_000);
  });
});
