import { validateSpanId, validateTraceId } from '@trace-flow/utils';
import { v } from 'convex/values';

export interface ConvexTraceContext {
  traceId: string;
  spanId: string;
  sampled: boolean;
}

export const convexTraceContextValidator = v.object({
  traceId: v.string(),
  spanId: v.string(),
  sampled: v.boolean(),
});

export function validateConvexTraceContext(context: ConvexTraceContext): void {
  if (!validateTraceId(context.traceId) || !validateSpanId(context.spanId)) {
    throw new Error('Invalid Convex trace context');
  }
}
