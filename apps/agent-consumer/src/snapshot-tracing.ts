import * as Sentry from '@sentry/cloudflare';
import {
  durableSentryTraceHeader,
  internalTraceHeaders,
  sentryTraceLinks,
} from '@trace-flow/utils/sentry-tracing';

const MAX_LINKS_PER_DAY = 32;

export function recordSnapshotProducer(storage: DurableObjectStorage, dirtyDays: string[]): void {
  const header = durableSentryTraceHeader({
    'sentry-trace': internalTraceHeaders().get('sentry-trace') ?? undefined,
  });
  if (!header) return;
  for (const day of dirtyDays) {
    storage.sql.exec(
      `INSERT OR IGNORE INTO snapshot_producer_traces (dirty_day, sentry_trace)
       SELECT ?, ? WHERE (SELECT COUNT(*) FROM snapshot_producer_traces WHERE dirty_day = ?) < ?`,
      day,
      header,
      day,
      MAX_LINKS_PER_DAY,
    );
  }
}

export function snapshotProducerHeaders(
  storage: DurableObjectStorage,
  generation: number,
): string[] {
  return storage.sql
    .exec<{ sentry_trace: string }>(
      `SELECT DISTINCT p.sentry_trace FROM snapshot_producer_traces p
     JOIN snapshot_days d ON d.dirty_day = p.dirty_day
     WHERE d.generation = ? ORDER BY p.sentry_trace LIMIT ?`,
      generation,
      MAX_LINKS_PER_DAY,
    )
    .toArray()
    .map((row) => row.sentry_trace);
}

export function linkSnapshotProducers(headers: string[], span = Sentry.getActiveSpan()): void {
  const links = sentryTraceLinks(headers);
  span?.addLinks(links);
  span?.setAttribute('trace_flow.producer_link_count', links.length);
  span?.setAttribute('trace_flow.producer_links_at_capacity', links.length === MAX_LINKS_PER_DAY);
}
