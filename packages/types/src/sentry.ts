/**
 * Sentry distributed-trace carriage across Cloudflare Queues.
 *
 * Cloudflare Queues have no header channel, and `@sentry/cloudflare`'s queue instrumentation starts
 * a brand new root trace for every consumer batch. Producers therefore copy their trace headers into
 * the message body so the consumer can `continueTrace` onto the request that enqueued the work.
 *
 * Keys are Sentry's own header names so the value round-trips through `getTraceData()` /
 * `continueTrace()` without a mapping step. Optional throughout: messages enqueued before this field
 * existed, or produced while tracing is disabled, still consume cleanly and simply start their own
 * trace.
 */
export interface SentryTraceContext {
  'sentry-trace'?: string;
  baggage?: string;
}
