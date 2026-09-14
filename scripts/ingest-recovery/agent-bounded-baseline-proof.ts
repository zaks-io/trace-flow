import type {
  BaselineCopyChunk,
  BoundedBaselineCopyCheckpoint,
} from '../../apps/agent-consumer/src/baseline-copy-contract';
import { FACT_VERSION_DATASOURCES } from '../../apps/agent-consumer/src/delivery-write';
import { quote } from './agent-data';
import { preserveBaselineCopyFailure } from './agent-baseline-copy-retry-journal';
import {
  baselineProjection,
  latestBaselineRows,
  migrationScope,
  retainedMigrationWindow,
  type MigrationWindow,
} from './agent-migration-proof';
import type { AgentRecoveryClient, AgentTinybirdClient } from './agent-transport';

export async function requireEmptyCategoryTarget(
  tb: AgentTinybirdClient,
  recovery: AgentRecoveryClient,
  category: BoundedBaselineCopyCheckpoint['category'],
): Promise<void> {
  const result = await tb.sql(
    `SELECT count() AS rows FROM ${FACT_VERSION_DATASOURCES[category]} FINAL WHERE OrgId=${quote(recovery.org)}`,
  );
  if (count(result.data[0]?.rows, 'bounded baseline target rows') !== 0) {
    throw new Error('Bounded baseline Copy requires an empty organization category target');
  }
}

export async function requireEmptyChunkTarget(
  tb: AgentTinybirdClient,
  recovery: AgentRecoveryClient,
  checkpoint: BoundedBaselineCopyCheckpoint,
  chunk: BaselineCopyChunk,
): Promise<void> {
  const result = await tb.sql(
    `SELECT count() AS rows FROM ${FACT_VERSION_DATASOURCES[checkpoint.category]} FINAL WHERE ${migrationScope(checkpoint.category, recovery.org, chunk)}`,
  );
  if (count(result.data[0]?.rows, 'bounded baseline chunk target rows') !== 0) {
    throw new Error('Bounded baseline Copy chunk target is not empty');
  }
}

export async function verifyChunkSource(
  tb: AgentTinybirdClient,
  recovery: AgentRecoveryClient,
  checkpoint: BoundedBaselineCopyCheckpoint,
  chunk: BaselineCopyChunk,
  retained: MigrationWindow | null = retainedSlice(chunk, retainedMigrationWindow()),
): Promise<number> {
  const expected = expectedRetained(checkpoint, chunk, retained);
  if (!retained) return 0;
  const projection = baselineProjection(checkpoint.category);
  const source = latestBaselineRows(
    checkpoint.category,
    recovery.org,
    checkpoint,
    retained,
    projection,
  );
  const result = await tb.sql(`SELECT count() AS rows,
    sum(length(toJSONString(tuple(${projection})))) AS projected_bytes
    FROM (${source})`);
  const rows = count(result.data[0]?.rows, 'bounded baseline retained source rows');
  const projectedBytes = count(
    result.data[0]?.projected_bytes,
    'bounded baseline retained source bytes',
  );
  if (rows !== expected.rows || projectedBytes !== expected.projectedBytes) {
    throw new Error('Bounded baseline Copy retained source changed after planning');
  }
  return rows;
}

export async function verifyCompletedChunkTarget(
  tb: AgentTinybirdClient,
  recovery: AgentRecoveryClient,
  checkpoint: BoundedBaselineCopyCheckpoint,
  chunk: BaselineCopyChunk,
  retained: MigrationWindow | null = retainedSlice(chunk, retainedMigrationWindow()),
): Promise<void> {
  const expected = expectedRetained(checkpoint, chunk, retained);
  if (!retained) return;
  const scope = migrationScope(checkpoint.category, recovery.org, retained);
  const result = await tb.sql(`SELECT count() AS rows,
    countIf(DeliverySequence != 1 OR IsDeleted != 0) AS invalid_rows
    FROM ${FACT_VERSION_DATASOURCES[checkpoint.category]} FINAL WHERE ${scope}`);
  if (
    count(result.data[0]?.rows, 'bounded baseline completed target rows') !== expected.rows ||
    count(result.data[0]?.invalid_rows, 'bounded baseline completed invalid rows') !== 0
  ) {
    throw new Error('Bounded baseline Copy completed target does not match its retained plan');
  }
}

export function preserveChunkFailure(
  root: string,
  recovery: AgentRecoveryClient,
  checkpoint: BoundedBaselineCopyCheckpoint,
  active: { copyAttempt: number; jobId: string },
  providerJob: Record<string, unknown>,
): void {
  preserveBaselineCopyFailure(root, {
    version: 1,
    orgId: recovery.org,
    checkpoint: {
      category: checkpoint.category,
      startDay: checkpoint.startDay,
      endDay: checkpoint.endDay,
      startedAt: checkpoint.startedAt,
      copyAttempt: active.copyAttempt,
      jobId: active.jobId,
      complete: false,
    },
    observedAt: Date.now(),
    providerJob,
  });
}

function expectedRetained(
  checkpoint: BoundedBaselineCopyCheckpoint,
  chunk: BaselineCopyChunk,
  retained: MigrationWindow | null,
): { rows: number; projectedBytes: number } {
  if (!retained) return { rows: 0, projectedBytes: 0 };
  return checkpoint.plan.dailyStats
    .filter((stat) => stat.day >= retained.startDay && stat.day <= retained.endDay)
    .reduce(
      (total, stat) => ({
        rows: total.rows + stat.rows,
        projectedBytes: total.projectedBytes + stat.projectedBytes,
      }),
      { rows: 0, projectedBytes: 0 },
    );
}

export function retainedSlice(
  chunk: BaselineCopyChunk,
  retained: MigrationWindow,
): MigrationWindow | null {
  const startDay = chunk.startDay > retained.startDay ? chunk.startDay : retained.startDay;
  const endDay = chunk.endDay < retained.endDay ? chunk.endDay : retained.endDay;
  return startDay <= endDay ? { startDay, endDay } : null;
}

function count(value: unknown, label: string): number {
  if (
    !(
      (typeof value === 'number' && Number.isSafeInteger(value)) ||
      (typeof value === 'string' && /^\d+$/.test(value))
    )
  ) {
    throw new Error(`Invalid ${label}`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`Invalid ${label}`);
  return number;
}
