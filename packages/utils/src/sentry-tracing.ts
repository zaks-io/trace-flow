/**
 * Sentry distributed-tracing plumbing shared by the Workers.
 *
 * Imported through the `@trace-flow/utils/sentry-tracing` subpath rather than the package barrel so
 * `@sentry/cloudflare` never reaches the browser bundle.
 */
import * as Sentry from '@sentry/cloudflare';
import type { SentryTraceContext } from '@trace-flow/types';
export { captureSafeException } from './sentry-exception';

type RequestPrivacyOptions = Pick<
  Sentry.CloudflareOptions,
  'integrations' | 'beforeSend' | 'beforeSendTransaction'
>;

function scrubUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return value.split(/[?#]/, 1)[0]!;
  }
}

function scrubRequestAttributes(data: Record<string, unknown> | undefined): void {
  if (!data) return;
  for (const key of Object.keys(data)) {
    if (
      key.startsWith('http.request.header.') ||
      ['url.query', 'url.fragment', 'http.query', 'http.fragment', 'baggage'].includes(key)
    ) {
      delete data[key];
    } else if (['url', 'url.full', 'http.url'].includes(key)) {
      if (typeof data[key] === 'string') data[key] = scrubUrl(data[key]);
      else delete data[key];
    }
  }
}

function scrubRequestEvent<T extends Sentry.Event>(event: T): T {
  if (event.request) {
    delete event.request.data;
    delete event.request.headers;
    delete event.request.cookies;
    delete event.request.query_string;
    if (event.request.url) event.request.url = scrubUrl(event.request.url);
  }
  scrubRequestAttributes(event.contexts?.trace?.data);
  for (const span of event.spans ?? []) scrubRequestAttributes(span.data);
  for (const breadcrumb of event.breadcrumbs ?? []) {
    scrubRequestAttributes(breadcrumb.data);
  }
  // Envelope headers serialize every incoming sentry-* field; local sampling is decided before export.
  const metadata = event.sdkProcessingMetadata;
  const sampling = metadata?.dynamicSamplingContext;
  if (metadata && sampling) {
    const safeSampling: Record<string, string> = {};
    const traceId = event.contexts?.trace?.trace_id;
    if (traceId && /^[0-9a-f]{32}$/.test(traceId)) safeSampling.trace_id = traceId;
    const publicKey = Sentry.getClient()?.getDsn()?.publicKey;
    if (publicKey) safeSampling.public_key = publicKey;
    for (const field of ['sample_rate', 'sample_rand'] as const) {
      const value = sampling[field];
      if (typeof value === 'string' && /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value)) {
        safeSampling[field] = value;
      }
    }
    if (sampling.sampled === 'true' || sampling.sampled === 'false') {
      safeSampling.sampled = sampling.sampled;
    }
    metadata.dynamicSamplingContext = safeSampling;
  }
  return event;
}

/** The SDK also copies URLs and headers directly to spans, outside its request-data integrations. */
export function sentryRequestPrivacy(): RequestPrivacyOptions {
  return {
    integrations: [
      Sentry.httpServerIntegration({ maxRequestBodySize: 'none' }),
      Sentry.requestDataIntegration({
        include: { data: false, headers: false, cookies: false, query_string: false, ip: false },
      }),
    ],
    beforeSend: scrubRequestEvent,
    // SDK 10.73.0 reconstructs the root for beforeSendSpan and drops its causal links.
    beforeSendTransaction: scrubRequestEvent,
  };
}

/**
 * Origins that may receive `sentry-trace` / `baggage` headers on outgoing fetches.
 *
 * The Cloudflare SDK attaches trace headers to *every* outgoing fetch when this is left unset, which
 * ships our trace ids and dynamic sampling context (release, environment, transaction name) to third
 * parties: LLM providers from the Proxy and Tinybird from the Pipes API. Every
 * Sentry-instrumented Worker passes this so propagation stays inside our own surface: relative URLs,
 * the production `*.trace-flow.dev` Worker routes (excluding the Convex custom domain), and the
 * `isaac-a46.workers.dev` routes the non-production Workers serve on. The account subdomain is part
 * of the pattern because bare `*.workers.dev` would match every other Cloudflare account too.
 * Authenticated Convex endpoints use explicit minimal propagation with receiver continuation.
 */
export const TRACE_FLOW_PROPAGATION_TARGETS: (string | RegExp)[] = [
  /^\//,
  /^https:\/\/(?!connect\.trace-flow\.dev(?:[/?#]|$))([^/?#]+\.)?trace-flow\.dev(\/|$)/,
  /^https:\/\/([^/?#]+\.)?isaac-a46\.workers\.dev(\/|$)/,
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/,
];

/** Trace headers of the currently active trace, for a producer to attach to a queue message. */
export function currentSentryTraceContext(): SentryTraceContext {
  const context = Sentry.getActiveSpan()?.spanContext();
  if (!context) return {};
  const header = durableSentryTraceHeader({
    'sentry-trace': `${context.traceId}-${context.spanId}-${context.traceFlags & 1 ? '1' : '0'}`,
  });
  return header ? { 'sentry-trace': header } : {};
}

/** Explicit propagation only to authenticated endpoints we own, without customer baggage. */
export function internalTraceHeaders(headers: HeadersInit = {}): Headers {
  const result = new Headers(headers);
  result.delete('sentry-trace');
  result.delete('baggage');
  result.delete('traceparent');
  result.delete('tracestate');
  const header = durableSentryTraceHeader(currentSentryTraceContext());
  if (header) {
    const [traceId, spanId, sampled] = header.split('-');
    result.set('sentry-trace', header);
    result.set('traceparent', `00-${traceId}-${spanId}-${sampled === '1' ? '01' : '00'}`);
  }
  return result;
}

/** Only IDs and a sampling bit may enter plaintext durable tracing metadata. */
export function durableSentryTraceHeader(context: SentryTraceContext | undefined): string | null {
  const header = context?.['sentry-trace'];
  if (!header || !/^[0-9a-f]{32}-[0-9a-f]{16}(?:-[01])?$/.test(header)) return null;
  const [traceId, spanId] = header.split('-');
  if (traceId === '0'.repeat(32) || spanId === '0'.repeat(16)) return null;
  return header;
}

type SentrySpanLink = Parameters<Sentry.Span['addLink']>[0];

export function sentryTraceLinks(
  headers: readonly (string | null | undefined)[],
  limit = 32,
): SentrySpanLink[] {
  const distinct = new Set(
    headers.filter((header) =>
      durableSentryTraceHeader(header ? { 'sentry-trace': header } : undefined),
    ),
  );
  return [...distinct].slice(0, limit).map((header) => {
    const [traceId, spanId, sampled] = header!.split('-');
    return {
      context: {
        traceId: traceId!,
        spanId: spanId!,
        traceFlags: sampled === '1' ? 1 : 0,
        isRemote: true,
      },
    };
  });
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
  span: {
    queueName: string;
    messageCount: number;
    attributes?: Parameters<Sentry.Span['setAttributes']>[0];
    links?: SentrySpanLink[];
  },
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
          links: span.links,
          attributes: {
            ...span.attributes,
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
