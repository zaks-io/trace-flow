import { createHash } from 'node:crypto';
import type { BaselineCopyPlan } from '../../apps/agent-consumer/src/baseline-copy-contract';
import {
  baselineCopyPlanHashInput,
  MAX_BASELINE_COPY_CHUNK_BYTES,
  MAX_BASELINE_COPY_CHUNK_DAYS,
  MAX_BASELINE_COPY_CHUNK_ROWS,
  validateBaselineCopyPlan,
} from '../../apps/agent-consumer/src/baseline-copy-plan';
import type { BaselineCategoryProof, MigrationWindow } from './agent-migration-proof';

export function buildBaselineCopyPlan(
  proof: BaselineCategoryProof,
  window: MigrationWindow,
): BaselineCopyPlan {
  if (proof.dailyStats.length === 0) throw new Error('Cannot plan an empty baseline Copy');
  const chunks: BaselineCopyPlan['chunks'] = [];
  let current: BaselineCopyPlan['chunks'][number] | undefined;
  for (const stat of proof.dailyStats) {
    if (
      stat.rows > MAX_BASELINE_COPY_CHUNK_ROWS ||
      stat.projectedBytes > MAX_BASELINE_COPY_CHUNK_BYTES
    ) {
      throw new Error(`Baseline Copy day ${stat.day} exceeds the bounded chunk limit`);
    }
    const canAppend =
      current &&
      dayNumber(stat.day) - dayNumber(current.startDay) < MAX_BASELINE_COPY_CHUNK_DAYS &&
      current.rows + stat.rows <= MAX_BASELINE_COPY_CHUNK_ROWS &&
      current.projectedBytes + stat.projectedBytes <= MAX_BASELINE_COPY_CHUNK_BYTES;
    if (!canAppend) {
      if (current) chunks.push(current);
      current = {
        startDay: stat.day,
        endDay: stat.day,
        rows: stat.rows,
        projectedBytes: stat.projectedBytes,
      };
    } else {
      current.endDay = stat.day;
      current.rows += stat.rows;
      current.projectedBytes += stat.projectedBytes;
    }
  }
  if (current) chunks.push(current);
  const plan: BaselineCopyPlan = {
    sha256: '0'.repeat(64),
    dailyStats: proof.dailyStats,
    chunks,
    totalRows: proof.rows,
    totalProjectedBytes: proof.dailyStats.reduce((sum, row) => sum + row.projectedBytes, 0),
  };
  plan.sha256 = createHash('sha256')
    .update(baselineCopyPlanHashInput(proof.category, window.startDay, window.endDay, plan))
    .digest('hex');
  validateBaselineCopyPlan(proof.category, window.startDay, window.endDay, plan);
  return plan;
}

function dayNumber(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`) / 86_400_000;
}
