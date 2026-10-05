import { describe, expect, it } from 'vitest';
import type { SentryTraceContext } from '@trace-flow/types';
import type * as Sentry from '@sentry/cloudflare';
import {
  groupBySentryTrace,
  sentryRequestPrivacy,
  TRACE_FLOW_PROPAGATION_TARGETS,
} from './sentry-tracing';

describe('Sentry request export privacy', () => {
  it('scrubs errors and transactions while retaining correlation and sampling', async () => {
    const privacy = sentryRequestPrivacy();
    for (const hook of [privacy.beforeSend!, privacy.beforeSendTransaction!]) {
      const event: Sentry.Event = {
        request: {
          url: 'https://user:password@example.test/path?key=private#private',
          headers: { baggage: 'private' },
          cookies: { customer: 'private' },
          data: 'private',
          query_string: 'key=private',
        },
        contexts: {
          trace: {
            trace_id: '1'.repeat(32),
            span_id: '2'.repeat(16),
            links: [{ trace_id: '4'.repeat(32), span_id: '5'.repeat(16), sampled: true }],
            data: {
              'http.request.header.baggage': 'private',
              'url.query': 'key=private',
              'url.full': 'https://example.test/path?key=private#private',
            },
          },
        },
        breadcrumbs: [{ data: { url: '/path?key=private#private' } }],
        spans: [
          {
            trace_id: '1'.repeat(32),
            span_id: '3'.repeat(16),
            parent_span_id: '2'.repeat(16),
            start_timestamp: 1,
            timestamp: 2,
            data: {
              'http.url': 'https://example.test/path?key=private',
              'http.query': 'key=private',
              'http.request.header.authorization': 'private',
            },
          },
        ],
        sdkProcessingMetadata: {
          dynamicSamplingContext: {
            release: 'private',
            sample_rate: '0.5',
            sample_rand: '0.25',
            sampled: 'true',
            trace_id: 'private',
          },
        },
      };
      Object.assign(event.sdkProcessingMetadata!.dynamicSamplingContext!, { custom: 'private' });
      const scrubbed = await hook(event as never, {});
      expect(JSON.stringify(scrubbed)).not.toContain('private');
      expect(scrubbed?.contexts?.trace).toMatchObject({
        trace_id: '1'.repeat(32),
        span_id: '2'.repeat(16),
        links: [{ trace_id: '4'.repeat(32), span_id: '5'.repeat(16), sampled: true }],
      });
      expect(scrubbed?.sdkProcessingMetadata?.dynamicSamplingContext).toEqual({
        trace_id: '1'.repeat(32),
        sample_rate: '0.5',
        sample_rand: '0.25',
        sampled: 'true',
      });
    }
  });

  it('rejects malformed sampling fields', async () => {
    const privacy = sentryRequestPrivacy();
    const event = await privacy.beforeSend!(
      {
        type: undefined,
        sdkProcessingMetadata: {
          dynamicSamplingContext: {
            sample_rate: 'private',
            sample_rand: '1.5',
            sampled: 'private',
          },
        },
      },
      {},
    );
    expect(event?.sdkProcessingMetadata?.dynamicSamplingContext).toEqual({});
  });
});

describe('Worker trace propagation targets', () => {
  it.each([
    'https://connect.trace-flow.dev',
    'https://connect.trace-flow.dev/api/mcp',
    'https://connect.trace-flow.dev?query=1',
    'https://example.convex.site/api/mcp',
    'https://api.tinybird.co/v0/pipes/traces.json',
    'https://api.openai.com/v1/responses',
    'https://other-account.workers.dev',
    'https://gateway.trace-flow.dev.evil.test/path',
  ])('excludes %s', (url) => {
    expect(
      TRACE_FLOW_PROPAGATION_TARGETS.some((target) =>
        typeof target === 'string' ? url.includes(target) : target.test(url),
      ),
    ).toBe(false);
  });

  it.each([
    '/api/own-worker',
    'https://gateway.trace-flow.dev/v1/traces',
    'https://raw.trace-flow.dev/bodies/request',
    'https://trace-flow-mcp-dev.isaac-a46.workers.dev/mcp',
    'http://localhost:3000/api/test',
  ])('includes %s', (url) => {
    expect(
      TRACE_FLOW_PROPAGATION_TARGETS.some((target) =>
        typeof target === 'string' ? url.includes(target) : target.test(url),
      ),
    ).toBe(true);
  });
});

interface Msg {
  id: string;
  trace?: SentryTraceContext;
}

const traceOf = (message: Msg) => message.trace;

const trace = (traceId: string): SentryTraceContext => ({
  'sentry-trace': `${traceId}-0000000000000001-1`,
  baggage: `sentry-trace_id=${traceId}`,
});

describe('groupBySentryTrace', () => {
  it('collapses messages sharing a producer trace into one group', () => {
    const groups = groupBySentryTrace(
      [
        { id: 'a', trace: trace('aaaa') },
        { id: 'b', trace: trace('aaaa') },
        { id: 'c', trace: trace('aaaa') },
      ],
      traceOf,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.messages.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(groups[0]?.traceContext).toEqual(trace('aaaa'));
  });

  it('keeps distinct traces apart and preserves first-seen order', () => {
    const groups = groupBySentryTrace(
      [
        { id: 'a', trace: trace('aaaa') },
        { id: 'b', trace: trace('bbbb') },
        { id: 'c', trace: trace('aaaa') },
      ],
      traceOf,
    );

    expect(groups.map((g) => g.messages.map((m) => m.id))).toEqual([['a', 'c'], ['b']]);
  });

  it('never correlates untraced messages with each other', () => {
    const groups = groupBySentryTrace([{ id: 'a' }, { id: 'b' }], traceOf);

    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.traceContext === undefined)).toBe(true);
  });

  it('treats a context missing the sentry-trace header as untraced', () => {
    const groups = groupBySentryTrace(
      [
        { id: 'a', trace: { baggage: 'sentry-release=1' } },
        { id: 'b', trace: { baggage: 'sentry-release=1' } },
      ],
      traceOf,
    );

    expect(groups).toHaveLength(2);
    expect(groups[0]?.traceContext).toBeUndefined();
  });

  it('returns no groups for an empty batch', () => {
    expect(groupBySentryTrace([], traceOf)).toEqual([]);
  });
});
