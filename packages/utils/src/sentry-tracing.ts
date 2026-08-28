/**
 * Sentry distributed-tracing plumbing shared by the Workers.
 *
 * Imported through the `@trace-flow/utils/sentry-tracing` subpath rather than the package barrel so
 * `@sentry/cloudflare` never reaches the browser bundle.
 */
import * as Sentry from '@sentry/cloudflare';
import type { SentryTraceContext } from '@trace-flow/types';

/**
 * Origins that may receive `sentry-trace` / `baggage` headers on outgoing fetches.
 *
 * The Cloudflare SDK attaches trace headers to *every* outgoing fetch when this is left unset, which
 * ships our trace ids and dynamic sampling context (release, environment, transaction name) to third
 * parties: LLM providers from the Proxy, Tinybird from the Pipes API, Convex from Agent Ingest. Every
 * Sentry-instrumented Worker passes this so propagation stays inside our own surface: relative URLs,
 * the production `*.trace-flow.dev` routes, and the `isaac-a46.workers.dev` routes the non-production
 * Workers serve on. The account subdomain is part of the pattern because bare `*.workers.dev` would
 * match every other Cloudflare account too.
 */
export const TRACE_FLOW_PROPAGATION_TARGETS: (string | RegExp)[] = [
  /^\//,
  /^https:\/\/([^/?#]+\.)?trace-flow\.dev(\/|$)/,
  /^https:\/\/([^/?#]+\.)?isaac-a46\.workers\.dev(\/|$)/,
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/,
];

/** Trace headers of the currently active trace, for a producer to attach to a queue message. */
export function currentSentryTraceContext(): SentryTraceContext {
  const traceData = Sentry.getTraceData();
  return { 'sentry-trace': traceData['sentry-trace'], baggage: traceData.baggage };
}

interface TracedGroup<T> {
  traceContext: SentryTraceContext | undefined;
  messages: T[];
}

/**
 * Groups a consumer batch by producing trace so one `queue.process` transaction covers every message
 * a single producer request enqueued. Agent Ingest chunks one HTTP request into up to a hundred queue
 * messages that all carry the same trace context; without grouping, one sampled ingest request would
 * open a hundred consumer transactions.
 *
 * Messages with no trace context can't be correlated with each other, so each gets its own group
 * rather than being lumped into one that would falsely imply a shared trace.
 */
export function groupBySentryTrace<T>(
  messages: readonly T[],
  traceContextOf: (message: T) => SentryTraceContext | undefined,
): TracedGroup<T>[] {
  const groups: TracedGroup<T>[] = [];
  const byTraceHeader = new Map<string, TracedGroup<T>>();

  for (const message of messages) {
    const traceContext = traceContextOf(message);
    const traceHeader = traceContext?.['sentry-trace'];

    if (!traceHeader) {
      groups.push({ traceContext: undefined, messages: [message] });
      continue;
    }

    const existing = byTraceHeader.get(traceHeader);
    if (existing) {
      existing.messages.push(message);
      continue;
    }

    const group: TracedGroup<T> = { traceContext, messages: [message] };
    byTraceHeader.set(traceHeader, group);
    groups.push(group);
  }

  return groups;
}

/**
 * Runs `callback` inside a `queue.process` transaction attached to the producer's trace.
 *
 * `continueTrace` clears the active span, so this becomes a root span of the producer's trace rather
 * than a child of the batch transaction `withSentry` opened — the consumer leg shows up as its own
 * transaction inside the originating request's trace, and inherits that request's sampling decision.
 * A missing trace context simply starts a fresh trace.
 */
export function continueQueueTrace<T>(
  traceContext: SentryTraceContext | undefined,
  span: { queueName: string; messageCount: number },
  callback: () => T,
): T {
  return Sentry.continueTrace(
    {
      sentryTrace: traceContext?.['sentry-trace'] ?? '',
      baggage: traceContext?.baggage ?? '',
    },
    () =>
      Sentry.startSpan(
        {
          name: `process ${span.queueName}`,
          op: 'queue.process',
          forceTransaction: true,
          attributes: {
            'messaging.system': 'cloudflare',
            'messaging.destination.name': span.queueName,
            'messaging.operation.type': 'process',
            'messaging.operation.name': 'process',
            'messaging.batch.message_count': span.messageCount,
            [Sentry.SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: 'auto.faas.cloudflare.queue',
            [Sentry.SEMANTIC_ATTRIBUTE_SENTRY_SOURCE]: 'task',
          },
        },
        callback,
      ),
  );
}
