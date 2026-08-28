import { describe, expect, it } from 'vitest';
import type { SentryTraceContext } from '@trace-flow/types';
import { groupBySentryTrace } from './sentry-tracing';

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
