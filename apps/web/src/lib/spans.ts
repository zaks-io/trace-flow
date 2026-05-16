import type { TraceSpanRow } from '@trace-flow/spans';

export { isLLMRequestSpan, parseSpanAttributes, type TraceSpanRow } from '@trace-flow/spans';

/**
 * Shape returned by the `trace_detail` pipe — every column SELECTed in
 * `pipes/trace_detail.pipe` is present (ParentSpanId is empty string for roots,
 * never undefined). Use this when consuming trace_detail data; use the
 * canonical `TraceSpanRow` when accepting spans from any pipe.
 */
export type TraceSpan = TraceSpanRow &
  Required<
    Pick<TraceSpanRow, 'ReceivedAt' | 'ParentSpanId' | 'StatusMessage' | 'ResourceAttributes'>
  > &
  Required<Pick<TraceSpanRow, 'Events.Timestamp' | 'Events.Name' | 'Events.Attributes'>>;
