import type {
  BaselineCopyCheckpoint,
  BaselineCopyPlan,
  BoundedBaselineCopyCheckpoint,
} from './baseline-copy-contract';
import { CATEGORIES, type Category } from './facts';
import { assertExactKeys } from './agent-delivery-coordinator-validation';

export const MAX_BASELINE_COPY_DAYS = 367;
export const MAX_BASELINE_COPY_CHUNK_DAYS = 7;
export const MAX_BASELINE_COPY_CHUNK_ROWS = 50_000;
export const MAX_BASELINE_COPY_CHUNK_BYTES = 64 * 1024 * 1024;
export const MAX_BASELINE_COPY_CHECKPOINT_BYTES = 128 * 1024;

export function isBoundedBaselineCopy(
  checkpoint: BaselineCopyCheckpoint,
): checkpoint is BoundedBaselineCopyCheckpoint {
  return 'mode' in checkpoint && checkpoint.mode === 'bounded';
}

export function baselineCopyPlanHashInput(
  category: Category,
  startDay: string,
  endDay: string,
  plan: BaselineCopyPlan,
): string {
  return JSON.stringify({
    version: 1,
    category,
    startDay,
    endDay,
    dailyStats: plan.dailyStats,
    chunks: plan.chunks,
    totalRows: plan.totalRows,
    totalProjectedBytes: plan.totalProjectedBytes,
  });
}

export function validateBaselineCopyPlan(
  category: Category,
  startDay: string,
  endDay: string,
  plan: BaselineCopyPlan,
): void {
  assertExactKeys(
    plan,
    ['sha256', 'dailyStats', 'chunks', 'totalRows', 'totalProjectedBytes'],
    'bounded baseline Copy plan',
  );
  const first = dayNumber(startDay);
  const last = dayNumber(endDay);
  if (!CATEGORIES.includes(category) || first > last || last - first >= MAX_BASELINE_COPY_DAYS) {
    throw new Error('Invalid bounded baseline Copy window');
  }
  if (
    !/^[0-9a-f]{64}$/.test(plan.sha256) ||
    !Array.isArray(plan.dailyStats) ||
    plan.dailyStats.length === 0 ||
    plan.dailyStats.length > MAX_BASELINE_COPY_DAYS ||
    !Array.isArray(plan.chunks) ||
    plan.chunks.length === 0 ||
    plan.chunks.length > MAX_BASELINE_COPY_DAYS
  ) {
    throw new Error('Invalid bounded baseline Copy plan');
  }

  let totalRows = 0;
  let totalBytes = 0;
  let previousDay = first - 1;
  for (const stat of plan.dailyStats) {
    assertExactKeys(
      stat,
      ['day', 'rows', 'projectedBytes'],
      'bounded baseline Copy daily statistic',
    );
    const day = dayNumber(stat.day);
    if (
      day <= previousDay ||
      day < first ||
      day > last ||
      !positiveBounded(stat.rows, MAX_BASELINE_COPY_CHUNK_ROWS) ||
      !positiveBounded(stat.projectedBytes, MAX_BASELINE_COPY_CHUNK_BYTES)
    ) {
      throw new Error('Invalid bounded baseline Copy daily statistics');
    }
    previousDay = day;
    totalRows += stat.rows;
    totalBytes += stat.projectedBytes;
  }
  if (plan.totalRows !== totalRows || plan.totalProjectedBytes !== totalBytes) {
    throw new Error('Bounded baseline Copy totals do not match daily statistics');
  }

  let dailyIndex = 0;
  let previousEnd = first - 1;
  for (const chunk of plan.chunks) {
    assertExactKeys(
      chunk,
      ['startDay', 'endDay', 'rows', 'projectedBytes'],
      'bounded baseline Copy chunk',
    );
    const chunkStart = dayNumber(chunk.startDay);
    const chunkEnd = dayNumber(chunk.endDay);
    if (
      chunkStart <= previousEnd ||
      chunkStart < first ||
      chunkEnd > last ||
      chunkEnd < chunkStart ||
      chunkEnd - chunkStart >= MAX_BASELINE_COPY_CHUNK_DAYS
    ) {
      throw new Error('Invalid bounded baseline Copy chunk range');
    }
    const startIndex = dailyIndex;
    let rows = 0;
    let bytes = 0;
    while (
      dailyIndex < plan.dailyStats.length &&
      dayNumber(plan.dailyStats[dailyIndex]!.day) <= chunkEnd
    ) {
      const stat = plan.dailyStats[dailyIndex]!;
      if (dayNumber(stat.day) < chunkStart) {
        throw new Error('Bounded baseline Copy chunks overlap daily statistics');
      }
      rows += stat.rows;
      bytes += stat.projectedBytes;
      dailyIndex++;
    }
    if (
      dailyIndex === startIndex ||
      plan.dailyStats[startIndex]!.day !== chunk.startDay ||
      plan.dailyStats[dailyIndex - 1]!.day !== chunk.endDay ||
      chunk.rows !== rows ||
      chunk.projectedBytes !== bytes ||
      !positiveBounded(rows, MAX_BASELINE_COPY_CHUNK_ROWS) ||
      !positiveBounded(bytes, MAX_BASELINE_COPY_CHUNK_BYTES)
    ) {
      throw new Error('Bounded baseline Copy chunk totals do not match daily statistics');
    }
    previousEnd = chunkEnd;
  }
  if (dailyIndex !== plan.dailyStats.length) {
    throw new Error('Bounded baseline Copy plan omits daily statistics');
  }
}

export function requireBoundedCheckpointSize(checkpoint: BoundedBaselineCopyCheckpoint): void {
  if (
    new TextEncoder().encode(JSON.stringify(checkpoint)).byteLength >
    MAX_BASELINE_COPY_CHECKPOINT_BYTES
  ) {
    throw new Error('Bounded baseline Copy checkpoint exceeds 128 KiB');
  }
}

function positiveBounded(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function dayNumber(day: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Invalid bounded baseline Copy date');
  const milliseconds = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== day) {
    throw new Error('Invalid bounded baseline Copy date');
  }
  return milliseconds / 86_400_000;
}
