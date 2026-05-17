import type { TinybirdTrace } from '@trace-flow/types';
import { generateSpanId } from '@trace-flow/utils';
import { STATUS_CODE, type SPAN_KIND } from './keys';
import type { SpanEventInput } from './attributes/messages';

const MS_TO_NS = 1_000_000;

export interface SpanBase {
  traceId: string;
  /** Nanosecond timestamp (already converted upstream). */
  receivedAt: number;
  apiKey: string;
  tierAtIngestion: string;
  /** Nanosecond timestamp for retention enforcement. */
  retentionExpiresAt: number;
  serviceName: string;
}

export interface SpanVariant {
  /** Optional; generated via `generateSpanId` when absent. */
  spanId?: string;
  spanName: string;
  spanKind: (typeof SPAN_KIND)[keyof typeof SPAN_KIND];
  parentSpanId: string;
  traceState?: string;
  /** Millisecond timestamp; builder converts to nanoseconds for Tinybird. */
  timestampMs: number;
  /** Millisecond duration; builder converts to nanoseconds. */
  durationMs: number;
  attributes: Record<string, string>;
  events?: SpanEventInput[];
  /** Cross-trace links. SpanIds default to empty. */
  linkedTraceIds?: string[];
  /** Defaults to `STATUS_CODE_OK`. Only the Root Span overrides for errors. */
  statusCode?: (typeof STATUS_CODE)[keyof typeof STATUS_CODE];
  statusMessage?: string;
}

/**
 * Repack ms-based span events into Tinybird's parallel `Events.*` arrays.
 * Exposed for direct testing; called internally by `createSpan`.
 */
export function packEvents(events: SpanEventInput[]): {
  Timestamp: number[];
  Name: string[];
  Attributes: string[];
} {
  const Timestamp: number[] = [];
  const Name: string[] = [];
  const Attributes: string[] = [];
  for (const e of events) {
    Timestamp.push(e.timestampMs * MS_TO_NS);
    Name.push(e.name);
    Attributes.push(JSON.stringify(e.attributes));
  }
  return { Timestamp, Name, Attributes };
}

/**
 * Build a TinybirdTrace row from a base context and a variant. Owns:
 *  - SpanId generation (when absent)
 *  - ms → ns conversion for Timestamp and Duration
 *  - parallel-array repacking for Events
 *  - ResourceAttributes shaping
 *  - empty defaults for Links and Events when omitted
 *  - tier + retention stamping
 *
 * Callers compose attribute helpers and decide which Span Variant to emit; the
 * full TinybirdTrace literal lives here, once.
 */
export function createSpan(base: SpanBase, variant: SpanVariant): TinybirdTrace {
  const events = variant.events
    ? packEvents(variant.events)
    : { Timestamp: [], Name: [], Attributes: [] };
  const links = variant.linkedTraceIds ?? [];

  return {
    ReceivedAt: base.receivedAt,
    Timestamp: variant.timestampMs * MS_TO_NS,
    TraceId: base.traceId,
    SpanId: variant.spanId ?? generateSpanId(),
    ParentSpanId: variant.parentSpanId,
    TraceState: variant.traceState ?? '',
    SpanName: variant.spanName,
    SpanKind: variant.spanKind,
    ServiceName: base.serviceName,
    ResourceAttributes: { 'service.name': base.serviceName },
    SpanAttributes: variant.attributes,
    Duration: variant.durationMs * MS_TO_NS,
    StatusCode: variant.statusCode ?? STATUS_CODE.OK,
    StatusMessage: variant.statusMessage ?? '',
    ApiKey: base.apiKey,
    'Events.Timestamp': events.Timestamp,
    'Events.Name': events.Name,
    'Events.Attributes': events.Attributes,
    'Links.TraceId': links,
    'Links.SpanId': [],
    'Links.TraceState': [],
    'Links.Attributes': [],
    TierAtIngestion: base.tierAtIngestion,
    RetentionExpiresAt: base.retentionExpiresAt,
  };
}
