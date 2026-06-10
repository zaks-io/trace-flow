import { z } from 'zod';

/**
 * Canonical read shape for spans returned by Tinybird otel_trace_spans pipes.
 *
 * Subset of the write shape (`TinybirdTrace` in @trace-flow/types); fields that
 * only certain pipes SELECT are optional. The `SpanAttributes` /
 * `ResourceAttributes` strings are JSON; call `parseSpanAttributes` to decode.
 *
 * Narrow projections for individual views use `Pick<TraceSpanRow, ...>` rather
 * than re-declaring interfaces.
 */
export interface TraceSpanRow {
  Timestamp: number;
  TraceId: string;
  SpanId: string;
  SpanName: string;
  ServiceName: string;
  Duration: number;
  StatusCode: string;
  SpanAttributes: string;

  ReceivedAt?: number;
  ParentSpanId?: string;
  SpanKind?: string;
  StatusMessage?: string;
  ResourceAttributes?: string;

  'Events.Timestamp'?: number[];
  'Events.Name'?: string[];
  'Events.Attributes'?: string[];

  /** Computed column some pipes denormalize from SpanAttributes for filtering. */
  BaggageOperation?: string;
}

export const TraceSpanRowSchema = z.object({
  Timestamp: z.number(),
  TraceId: z.string(),
  SpanId: z.string(),
  SpanName: z.string(),
  ServiceName: z.string(),
  Duration: z.number(),
  StatusCode: z.string(),
  SpanAttributes: z.string(),

  ReceivedAt: z.number().optional(),
  ParentSpanId: z.string().optional(),
  SpanKind: z.string().optional(),
  StatusMessage: z.string().optional(),
  ResourceAttributes: z.string().optional(),

  'Events.Timestamp': z.array(z.number()).optional(),
  'Events.Name': z.array(z.string()).optional(),
  'Events.Attributes': z.array(z.string()).optional(),

  BaggageOperation: z.string().optional(),
}) satisfies z.ZodType<TraceSpanRow>;
