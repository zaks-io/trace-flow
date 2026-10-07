import type { Logger } from '@trace-flow/logging';
import type { TraceDeliveryMessage } from '@trace-flow/types';
import { TRACE_DELIVERY_PREFIX } from '@trace-flow/utils';
import { validateNamespace } from './delivery';

const LIST_PAGE_SIZE = 1_000;
const MAX_SWEEP_PAGES = 10;
const QUEUE_BATCH_SIZE = 100;
const SWEEP_MIN_AGE_MS = 5 * 60_000;
const SWEEP_BUDGET_MS = 30_000;

export interface SweepMetrics {
  pages: number;
  listAttempts: number;
  throttles: number;
  queueBatchAttempts: number;
  passAgeMs: number;
  scanned: number;
  enqueued: number;
  enqueueFailures: number;
  latencyMs: number;
  resumed: boolean;
  hasMore: boolean;
  stopReason: 'complete' | 'page_limit' | 'time_budget' | 'error';
}

export function createSweepMetrics(resumed: boolean): SweepMetrics {
  return {
    pages: 0,
    listAttempts: 0,
    throttles: 0,
    queueBatchAttempts: 0,
    passAgeMs: 0,
    scanned: 0,
    enqueued: 0,
    enqueueFailures: 0,
    latencyMs: 0,
    resumed,
    hasMore: true,
    stopReason: 'error',
  };
}

export async function sweepTraceDeliveries(
  storage: R2Bucket,
  queue: Queue<TraceDeliveryMessage>,
  logger: Logger,
  namespace: string,
  progress: {
    startAfter?: string;
    checkpoint: (startAfter: string | undefined) => Promise<void>;
    metrics: SweepMetrics;
  },
  now = Date.now(),
): Promise<SweepMetrics> {
  const prefix = `${TRACE_DELIVERY_PREFIX}${validateNamespace(namespace)}-`;
  const { metrics, checkpoint } = progress;
  let startAfter = progress.startAfter;
  const startedAt = Date.now();

  try {
    while (metrics.pages < MAX_SWEEP_PAGES) {
      if (metrics.pages > 0 && Date.now() - startedAt >= SWEEP_BUDGET_MS) {
        metrics.stopReason = 'time_budget';
        return metrics;
      }
      const page = await listTraceDeliveryPage(
        storage,
        { prefix, limit: LIST_PAGE_SIZE, startAfter },
        metrics,
      );
      metrics.pages++;
      metrics.scanned += page.objects.length;
      const lastKey = page.objects.at(-1)?.key;
      if (page.truncated && (!lastKey || (startAfter !== undefined && lastKey <= startAfter))) {
        throw new Error('Trace delivery sweep position did not advance');
      }

      const pending = page.objects.filter(
        (object) => now - object.uploaded.getTime() >= SWEEP_MIN_AGE_MS,
      );
      for (let offset = 0; offset < pending.length; offset += QUEUE_BATCH_SIZE) {
        const batch = pending.slice(offset, offset + QUEUE_BATCH_SIZE);
        metrics.queueBatchAttempts++;
        try {
          await queue.sendBatch(
            batch.map((object) => ({ body: { type: 'delivery', key: object.key } })),
          );
          metrics.enqueued += batch.length;
        } catch (error) {
          metrics.enqueueFailures++;
          logger.error('proxy.delivery_sweep_enqueue_failed', error, { batchSize: batch.length });
          // Retain this page's checkpoint so a failed publication cannot be skipped.
          throw error;
        }
      }

      startAfter = page.truncated ? lastKey : undefined;
      await checkpoint(startAfter);
      metrics.hasMore = page.truncated;
      if (!page.truncated) {
        metrics.stopReason = 'complete';
        return metrics;
      }
    }
    metrics.stopReason = 'page_limit';
    return metrics;
  } finally {
    metrics.latencyMs = Date.now() - startedAt;
  }
}

async function listTraceDeliveryPage(
  storage: R2Bucket,
  options: R2ListOptions,
  metrics: SweepMetrics,
) {
  for (let attempt = 0; ; attempt++) {
    metrics.listAttempts++;
    try {
      return await storage.list(options);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.endsWith('(10058)')) throw error;
      metrics.throttles++;
      if (attempt >= 3) throw error;
      const delay = 1_000 * 2 ** attempt + Math.floor(Math.random() * 250);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
