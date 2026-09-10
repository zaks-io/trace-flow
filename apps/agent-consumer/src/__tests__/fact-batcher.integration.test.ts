import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env as workerEnv } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { insertRows, TinybirdInsertError } from '@trace-flow/tinybird-client';
import type * as TinybirdClient from '@trace-flow/tinybird-client';
import type { AgentFactBatcherInstance } from '../fact-batcher';
import { AGENT_FACT_BATCHER_FLUSH_INTERVAL_MS } from '../fact-batcher';
import { batchContext, toolEventRow } from '../rows';
import { queueMessage, toolEventFact } from './factories';
import { stableHash } from '../facts';

vi.mock('@trace-flow/tinybird-client', async (importOriginal) => ({
  ...(await importOriginal<typeof TinybirdClient>()),
  insertRows: vi.fn().mockResolvedValue(undefined),
}));

const env = workerEnv as unknown as {
  AGENT_FACT_BATCHER: DurableObjectNamespace<AgentFactBatcherInstance>;
};

const sparseBatch = {
  rows: {
    messages: [
      {
        OrgId: 'org-1',
        session_pk: 'session-1',
        message_pk: 'message-1',
        IngestedAt: '2024-01-01 00:00:00.000',
      },
    ],
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
      try {
        await instance.alarm();
      } finally {
        await state.storage.deleteAlarm();
      }
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
      await instance.alarm();
      await instance.addFacts({
        rows: {
          ...emptyBatchRows,
          messages: [
            {
              OrgId: 'org-1',
              session_pk: 'session-1',
              message_pk: 'message-1',
              IngestedAt: '2024-01-01 00:00:01.000',
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

  it('coalesces a changed identity before its first insert', async () => {
    const first = { ...sparseBatch.rows.messages[0], output_tokens: 1 };
    const latest = { ...first, output_tokens: 42 };
    await runInDurableObject(batcher, async (instance: AgentFactBatcherInstance, state) => {
      await instance.addFacts({ rows: { ...emptyBatchRows, messages: [first] } });
      await state.storage.deleteAlarm();
      const changed = await instance.addFacts({ rows: { ...emptyBatchRows, messages: [latest] } });
      expect(changed).toMatchObject({ status: 'accepted', acceptedRows: 1, repairRows: 0 });
      await instance.alarm();
      await state.storage.deleteAlarm();
    });

    expect(insertRows).toHaveBeenCalledOnce();
    expect(vi.mocked(insertRows).mock.calls[0]?.[0]).toEqual([latest]);
    const recovery = await runInDurableObject(batcher, (instance: AgentFactBatcherInstance) =>
      instance.listRecovery(),
    );
    expect(recovery.records).toHaveLength(0);
  });

  it('keeps the newest pending version when an intermediate change arrives later', async () => {
    const first = {
      ...sparseBatch.rows.messages[0],
      IngestedAt: '2024-01-01 00:00:01.000',
      output_tokens: 1,
    };
    const newestSameContent = { ...first, IngestedAt: '2024-01-01 00:00:03.000' };
    const delayedChange = {
      ...first,
      IngestedAt: '2024-01-01 00:00:02.000',
      output_tokens: 42,
    };
    const results = await runInDurableObject(
      batcher,
      async (instance: AgentFactBatcherInstance, state) => {
        await instance.addFacts({ rows: { ...emptyBatchRows, messages: [first] } });
        await state.storage.deleteAlarm();
        const refreshed = await instance.addFacts({
          rows: { ...emptyBatchRows, messages: [newestSameContent] },
        });
        await state.storage.deleteAlarm();
        const stale = await instance.addFacts({
          rows: { ...emptyBatchRows, messages: [delayedChange] },
        });
        await instance.alarm();
        await state.storage.deleteAlarm();
        return { refreshed, stale };
      },
    );

    expect(results.refreshed).toMatchObject({ duplicateRows: 1, repairRows: 0 });
    expect(results.stale).toMatchObject({ acceptedRows: 0, duplicateRows: 1, repairRows: 0 });
    expect(insertRows).toHaveBeenCalledOnce();
    expect(vi.mocked(insertRows).mock.calls[0]?.[0]).toEqual([newestSameContent]);
    const recovery = await runInDurableObject(batcher, (instance: AgentFactBatcherInstance) =>
      instance.listRecovery(),
    );
    expect(recovery.records).toHaveLength(0);
  });

  it('rejects an invalid timestamp without replacing pending data', async () => {
    const first = { ...sparseBatch.rows.messages[0], output_tokens: 1 };
    const invalid = { ...first, IngestedAt: 'not-a-timestamp', output_tokens: 42 };
    const result = await runInDurableObject(
      batcher,
      async (instance: AgentFactBatcherInstance, state) => {
        await instance.addFacts({ rows: { ...emptyBatchRows, messages: [first] } });
        await state.storage.deleteAlarm();
        const failed = await instance.addFacts({
          rows: { ...emptyBatchRows, messages: [invalid] },
        });
        await instance.alarm();
        await state.storage.deleteAlarm();
        return failed;
      },
    );

    expect(result.status).toBe('failed');
    expect(insertRows).toHaveBeenCalledOnce();
    expect(vi.mocked(insertRows).mock.calls[0]?.[0]).toEqual([first]);
  });

  it('preserves corrections for later rows held by a bisected flush', async () => {
    vi.useRealTimers();
    const rows = ['first', 'malformed', 'later', 'last'].map((message_pk) => ({
      ...sparseBatch.rows.messages[0],
      message_pk,
      output_tokens: 1,
    }));
    let startInsert!: () => void;
    let releaseInsert!: () => void;
    const started = new Promise<void>((resolve) => {
      startInsert = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseInsert = resolve;
    });
    vi.mocked(insertRows).mockImplementationOnce(async () => {
      startInsert();
      await release;
    });
    const corrected = { ...rows[2]!, output_tokens: 42 };
    const changed = await runInDurableObject(
      batcher,
      async (instance: AgentFactBatcherInstance, state) => {
        await instance.addFacts({ rows: { ...emptyBatchRows, messages: rows } });
        await state.storage.deleteAlarm();
        state.storage.sql.exec(
          "UPDATE pending_facts SET data = '{' WHERE id = (SELECT id FROM pending_facts ORDER BY id LIMIT 1 OFFSET 1)",
        );
        const flushing = instance.alarm();
        await started;
        try {
          return await instance.addFacts({ rows: { ...emptyBatchRows, messages: [corrected] } });
        } finally {
          releaseInsert();
          await flushing;
          await state.storage.deleteAlarm();
        }
      },
    );
    expect(changed).toMatchObject({ repairRows: 1, acceptedRows: 0 });
    const recovery = await runInDurableObject(batcher, (instance: AgentFactBatcherInstance) =>
      instance.listRecovery(),
    );
    expect(
      recovery.records
        .filter((record) => record.kind === 'repair')
        .map((record) => JSON.parse(record.payload)),
    ).toEqual([corrected]);
    const inserted = vi.mocked(insertRows).mock.calls.flatMap((call) => call[0]);
    expect(inserted).toContainEqual(rows[2]);
  });

  it('loads at most 500 pending candidates per flush pass', async () => {
    vi.useRealTimers();
    const scheduled = await runInDurableObject(
      batcher,
      async (instance: AgentFactBatcherInstance, state) => {
        state.storage.sql.exec(`
        WITH RECURSIVE sequence(value) AS (
          SELECT 0 UNION ALL SELECT value + 1 FROM sequence WHERE value < 499
        )
        INSERT INTO pending_facts (category, fact_id, content_hash, data, created_at_ms)
        SELECT 'messages', 'seed-' || value, 'hash-' || value,
          json_object(
            'OrgId', 'org-1',
            'session_pk', 'bounded-flush',
            'message_pk', 'seed-' || value
          ), 0
        FROM sequence
      `);
        await instance.addFacts({
          rows: {
            ...emptyBatchRows,
            messages: [{ OrgId: 'org-1', session_pk: 'bounded-flush', message_pk: 'message-500' }],
          },
        });
        await state.storage.deleteAlarm();
        const before = Date.now();
        await instance.alarm();
        const alarm = await state.storage.getAlarm();
        const after = Date.now();
        await state.storage.deleteAlarm();
        return { after, before, alarm };
      },
    );

    expect(vi.mocked(insertRows).mock.calls[0]?.[0]).toHaveLength(500);
    expect(scheduled.alarm).toBeGreaterThanOrEqual(scheduled.before + 1_000);
    expect(scheduled.alarm).toBeLessThanOrEqual(scheduled.after + 1_000);
    expect(
      await runInDurableObject(batcher, (instance: AgentFactBatcherInstance) =>
        instance.getStats(),
      ),
    ).toMatchObject({ queuedRows: 1 });
    await flushNow();
    expect(vi.mocked(insertRows).mock.calls[1]?.[0]).toHaveLength(1);
  });

  it('retries promptly when the payload byte cap leaves eligible rows', async () => {
    vi.useRealTimers();
    const content = 'x'.repeat(500_000);
    const scheduled = await runInDurableObject(
      batcher,
      async (instance: AgentFactBatcherInstance, state) => {
        await instance.addFacts({
          rows: {
            ...emptyBatchRows,
            messages: [
              { OrgId: 'org-1', session_pk: 'byte-cap', message_pk: 'message-1', content },
              { OrgId: 'org-1', session_pk: 'byte-cap', message_pk: 'message-2', content },
            ],
          },
        });
        await state.storage.deleteAlarm();
        const before = Date.now();
        await instance.alarm();
        const alarm = await state.storage.getAlarm();
        const after = Date.now();
        await state.storage.deleteAlarm();
        return { after, before, alarm };
      },
    );

    expect(vi.mocked(insertRows).mock.calls[0]?.[0]).toHaveLength(1);
    expect(scheduled.alarm).toBeGreaterThanOrEqual(scheduled.before + 1_000);
    expect(scheduled.alarm).toBeLessThanOrEqual(scheduled.after + 1_000);
  });

  it('promotes an alarm scheduled by addFacts while a capped flush is in flight', async () => {
    vi.useRealTimers();
    let startInsert!: () => void;
    let releaseInsert!: () => void;
    const started = new Promise<void>((resolve) => {
      startInsert = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseInsert = resolve;
    });
    vi.mocked(insertRows).mockImplementationOnce(async () => {
      startInsert();
      await release;
    });

    const scheduled = await runInDurableObject(
      batcher,
      async (instance: AgentFactBatcherInstance, state) => {
        state.storage.sql.exec(`
          WITH RECURSIVE sequence(value) AS (
            SELECT 0 UNION ALL SELECT value + 1 FROM sequence WHERE value < 499
          )
          INSERT INTO pending_facts (category, fact_id, content_hash, data, created_at_ms)
          SELECT 'messages', 'seed-' || value, 'hash-' || value,
            json_object(
              'OrgId', 'org-1',
              'session_pk', 'alarm-promotion',
              'message_pk', 'seed-' || value
            ), 0
          FROM sequence
        `);
        await instance.addFacts(sparseBatch);
        await state.storage.deleteAlarm();
        const before = Date.now();
        const flushing = instance.alarm();
        await started;
        let normalAlarm: number | null = null;
        try {
          await instance.addFacts({
            rows: {
              ...emptyBatchRows,
              messages: [
                { OrgId: 'org-1', session_pk: 'alarm-promotion', message_pk: 'concurrent' },
              ],
            },
          });
          normalAlarm = await state.storage.getAlarm();
        } finally {
          releaseInsert();
          await flushing;
        }
        const promotedAlarm = await state.storage.getAlarm();
        const after = Date.now();
        await state.storage.deleteAlarm();
        return { after, before, normalAlarm, promotedAlarm };
      },
    );

    expect(scheduled.normalAlarm).toBeGreaterThanOrEqual(
      scheduled.before + AGENT_FACT_BATCHER_FLUSH_INTERVAL_MS,
    );
    expect(scheduled.promotedAlarm).toBeGreaterThanOrEqual(scheduled.before + 1_000);
    expect(scheduled.promotedAlarm).toBeLessThanOrEqual(scheduled.after + 1_000);
  });

  it('keeps the normal backoff when a later category fails after a capped category', async () => {
    vi.useRealTimers();
    vi.mocked(insertRows)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new TinybirdInsertError(429, 'rate limited'));
    const scheduled = await runInDurableObject(
      batcher,
      async (instance: AgentFactBatcherInstance, state) => {
        state.storage.sql.exec(`
          WITH RECURSIVE sequence(value) AS (
            SELECT 0 UNION ALL SELECT value + 1 FROM sequence WHERE value < 499
          )
          INSERT INTO pending_facts (category, fact_id, content_hash, data, created_at_ms)
          SELECT 'messages', 'seed-' || value, 'hash-' || value,
            json_object(
              'OrgId', 'org-1',
              'session_pk', 'retry-backoff',
              'message_pk', 'seed-' || value
            ), 0
          FROM sequence
        `);
        await instance.addFacts({
          rows: {
            ...emptyBatchRows,
            tool_events: [
              toolEventRow(batchContext(queueMessage()), toolEventFact({ tool_use_pk: 'later' })),
            ],
          },
        });
        await state.storage.deleteAlarm();
        const before = Date.now();
        let error = '';
        try {
          await instance.alarm();
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
        const alarm = await state.storage.getAlarm();
        const after = Date.now();
        await state.storage.deleteAlarm();
        return { after, before, alarm, error };
      },
    );

    expect(scheduled.error).toContain('status=429');
    expect(scheduled.alarm).toBeGreaterThanOrEqual(
      scheduled.before + AGENT_FACT_BATCHER_FLUSH_INTERVAL_MS,
    );
    expect(scheduled.alarm).toBeLessThanOrEqual(
      scheduled.after + AGENT_FACT_BATCHER_FLUSH_INTERVAL_MS,
    );
    expect(
      await runInDurableObject(batcher, (instance: AgentFactBatcherInstance) =>
        instance.getStats(),
      ),
    ).toMatchObject({ queuedRows: 1, blockedRecoveryRecords: 0 });
  });

  it('preserves a changed identity after its first insert as a repair', async () => {
    const first = { ...sparseBatch.rows.messages[0], output_tokens: 1 };
    const latest = { ...first, output_tokens: 42 };
    await runInDurableObject(batcher, async (instance: AgentFactBatcherInstance, state) => {
      await instance.addFacts({ rows: { ...emptyBatchRows, messages: [first] } });
      await instance.alarm();
      await instance.addFacts({ rows: { ...emptyBatchRows, messages: [latest] } });
      await state.storage.deleteAlarm();
    });

    expect(insertRows).toHaveBeenCalledOnce();
    const recovery = await runInDurableObject(batcher, (instance: AgentFactBatcherInstance) =>
      instance.listRecovery(),
    );
    expect(recovery.records).toHaveLength(1);
    expect(JSON.parse(recovery.records[0]!.payload)).toEqual(latest);
  });

  it('refreshes a sent ledger watermark before preserving an intermediate repair', async () => {
    const first = {
      ...sparseBatch.rows.messages[0],
      IngestedAt: '2024-01-01 00:00:01.000',
      output_tokens: 1,
    };
    const newestSameContent = { ...first, IngestedAt: '2024-01-01 00:00:03.000' };
    const delayedChange = {
      ...first,
      IngestedAt: '2024-01-01 00:00:02.000',
      output_tokens: 42,
    };
    const result = await runInDurableObject(
      batcher,
      async (instance: AgentFactBatcherInstance, state) => {
        await instance.addFacts({ rows: { ...emptyBatchRows, messages: [first] } });
        await instance.alarm();
        const refreshed = await instance.addFacts({
          rows: { ...emptyBatchRows, messages: [newestSameContent] },
        });
        const repaired = await instance.addFacts({
          rows: { ...emptyBatchRows, messages: [delayedChange] },
        });
        await state.storage.deleteAlarm();
        const ledger = state.storage.sql
          .exec<{ data: string }>('SELECT data FROM fact_ledger')
          .one();
        return { refreshed, repaired, ledger: JSON.parse(ledger.data) };
      },
    );

    expect(result.refreshed).toMatchObject({ duplicateRows: 1, repairRows: 0 });
    expect(result.repaired).toMatchObject({ acceptedRows: 0, repairRows: 1 });
    expect(result.ledger).toEqual(newestSameContent);
    expect(insertRows).toHaveBeenCalledOnce();
    const recovery = await runInDurableObject(batcher, (instance: AgentFactBatcherInstance) =>
      instance.listRecovery(),
    );
    expect(recovery.records).toHaveLength(1);
    expect(JSON.parse(recovery.records[0]!.payload)).toEqual(delayedChange);
  });

  it('locks a rebuild without mutating a pending identity while its insert is in flight', async () => {
    vi.useRealTimers();
    const first = { ...sparseBatch.rows.messages[0], output_tokens: 1 };
    const latest = { ...first, output_tokens: 42 };
    let startInsert!: () => void;
    let releaseInsert!: () => void;
    const started = new Promise<void>((resolve) => {
      startInsert = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseInsert = resolve;
    });
    vi.mocked(insertRows).mockImplementationOnce(async () => {
      startInsert();
      await release;
    });

    const hashes = await runInDurableObject(
      batcher,
      async (instance: AgentFactBatcherInstance, state) => {
        await instance.addFacts({ rows: { ...emptyBatchRows, messages: [first] } });
        await state.storage.deleteAlarm();
        const flushing = instance.alarm();
        await started;
        const changed = await instance.addFacts({
          rows: { ...emptyBatchRows, messages: [latest] },
        });
        const rebuild = await instance.beginFactRebuild('org-1', {
          operationId: 'rebuild-during-insert',
          executorId: '11111111-1111-4111-8111-111111111111',
          reason: 'pause while the current insert finishes',
          tinybirdWorkspaceId: '33333333-3333-4333-8333-333333333333',
          tinybirdTokenFingerprints: [
            '02678c7d0b2ede6174be0b3e990a2a3cd18a45640f35d6ae636f6342acba2e4e',
          ],
        });
        const values = {
          changed,
          rebuild,
          ledger: state.storage.sql
            .exec<{ content_hash: string }>('SELECT content_hash FROM fact_ledger')
            .one().content_hash,
          pending: state.storage.sql
            .exec<{ content_hash: string }>('SELECT content_hash FROM pending_facts')
            .one().content_hash,
        };
        releaseInsert();
        await flushing;
        return values;
      },
    );

    expect(hashes.changed).toMatchObject({ repairRows: 1, acceptedRows: 0 });
    expect(hashes.rebuild.status).toBe('retry-needed');
    expect(hashes.ledger).toBe(stableHash(first));
    expect(hashes.pending).toBe(stableHash(first));
    expect(
      (
        await batcher.beginFactRebuild('org-1', {
          operationId: 'rebuild-during-insert',
          executorId: '11111111-1111-4111-8111-111111111111',
          reason: 'pause while the current insert finishes',
          tinybirdWorkspaceId: '33333333-3333-4333-8333-333333333333',
          tinybirdTokenFingerprints: [
            '02678c7d0b2ede6174be0b3e990a2a3cd18a45640f35d6ae636f6342acba2e4e',
          ],
        })
      ).status,
    ).toBe('quiescent');
    expect(
      await runInDurableObject(batcher, async (_instance, state) => state.storage.getAlarm()),
    ).toBeNull();
  });

  it('dedupes repeated repair candidates', async () => {
    const changedBatch = {
      rows: {
        ...emptyBatchRows,
        messages: [
          {
            ...sparseBatch.rows.messages[0],
            content: 'changed',
          },
        ],
      },
    };
    await runInDurableObject(batcher, async (instance: AgentFactBatcherInstance, state) => {
      await instance.addFacts(sparseBatch);
      await instance.alarm();
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

  it('preserves a newer timestamp for repeated repair content', async () => {
    const original = {
      ...sparseBatch.rows.messages[0],
      IngestedAt: '2024-01-01 08:00:00.000',
      content: 'A',
    };
    const firstB = { ...original, IngestedAt: '2024-01-01 10:00:00.000', content: 'B' };
    const c = { ...original, IngestedAt: '2024-01-01 11:00:00.000', content: 'C' };
    const latestB = { ...original, IngestedAt: '2024-01-01T12:00:00.000Z', content: 'B' };
    await runInDurableObject(batcher, async (instance: AgentFactBatcherInstance, state) => {
      await instance.addFacts({ rows: { ...emptyBatchRows, messages: [original] } });
      await instance.alarm();
      await instance.addFacts({ rows: { ...emptyBatchRows, messages: [firstB] } });
      await instance.addFacts({ rows: { ...emptyBatchRows, messages: [c] } });
      await instance.addFacts({ rows: { ...emptyBatchRows, messages: [latestB] } });
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
    expect(result.repairs).toBe(3);
    expect(result.recovery.records.map((record) => JSON.parse(record.payload))).toEqual([
      firstB,
      c,
      latestB,
    ]);
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
