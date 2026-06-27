import { describe, expect, it } from 'vitest';
import { runUsageTotal, toPiRunRows, type SandboxRunEventInput } from '../analystPiRows';

function event(partial: Partial<SandboxRunEventInput> & { seq: number }): SandboxRunEventInput {
  return {
    _id: `event_${partial.seq}` as never,
    type: 'message',
    emittedAt: partial.seq,
    ...partial,
  };
}

describe('toPiRunRows', () => {
  it('projects a clean tool event into one completed tool row', () => {
    const rows = toPiRunRows([
      event({
        seq: 1,
        data: {
          kind: 'tool',
          toolName: 'bash',
          command: 'curl -s http://localhost/openapi.json',
          output: 'PATH: /tools/query_agent_analytics',
          isError: false,
        },
      }),
    ]);

    expect(rows).toEqual([
      {
        kind: 'tool',
        key: 'event_1',
        toolName: 'bash',
        command: 'curl -s http://localhost/openapi.json',
        output: 'PATH: /tools/query_agent_analytics',
        isError: false,
      },
    ]);
  });

  it('marks failed tool events as errors', () => {
    const [row] = toPiRunRows([
      event({
        seq: 1,
        type: 'error',
        data: { kind: 'tool', toolName: 'bash', command: 'false', output: 'exit 1', isError: true },
      }),
    ]);
    expect(row).toMatchObject({ kind: 'tool', toolName: 'bash', isError: true });
  });

  it('projects a turn into a single text row', () => {
    const [row] = toPiRunRows([
      event({
        seq: 1,
        data: { kind: 'text', text: 'The summary view returns one aggregate row.' },
      }),
    ]);
    expect(row).toEqual({
      kind: 'text',
      key: 'event_1',
      text: 'The summary view returns one aggregate row.',
    });
  });

  it('drops status heartbeats and lifecycle noise', () => {
    const rows = toPiRunRows([
      event({ seq: 1, type: 'status', message: 'Pi runner heartbeat' }),
      event({ seq: 2, type: 'status', message: 'Starting Pi session' }),
      event({ seq: 3, type: 'control', message: 'cancel' }),
    ]);
    expect(rows).toHaveLength(0);
  });

  it('drops usage snapshots from the work log', () => {
    const usage = (seq: number, total: number): SandboxRunEventInput =>
      event({ seq, type: 'usage', data: { usage: { tokens: { totalTokens: total } } } });

    const rows = toPiRunRows([
      usage(1, 100),
      event({ seq: 2, data: { kind: 'text', text: 'working' } }),
      usage(3, 250),
    ]);

    expect(rows).toEqual([{ kind: 'text', key: 'event_2', text: 'working' }]);
  });

  it('never emits raw JSON for unstructured events', () => {
    const rows = toPiRunRows([event({ seq: 1, type: 'message', message: 'message_update' })]);
    expect(rows).toHaveLength(0);
  });
});

describe('runUsageTotal', () => {
  it('returns the latest cumulative usage snapshot as the run total', () => {
    const usage = (seq: number, total: number): SandboxRunEventInput =>
      event({ seq, type: 'usage', data: { usage: { tokens: { totalTokens: total } } } });

    expect(
      runUsageTotal([
        usage(1, 100),
        event({ seq: 2, data: { kind: 'text', text: 'working' } }),
        usage(3, 250),
        usage(4, 380),
      ]),
    ).toEqual({
      totalTokens: 380,
      cacheRead: undefined,
      totalCost: undefined,
      contextPercent: undefined,
    });
  });

  it('parses cost (object breakdown) and context percent from the snapshot', () => {
    expect(
      runUsageTotal([
        event({
          seq: 1,
          type: 'usage',
          data: {
            usage: {
              tokens: { totalTokens: 2500, cacheRead: 1920 },
              cost: { total: 0.0088 },
              contextUsage: { percent: 6.1 },
            },
          },
        }),
      ]),
    ).toMatchObject({ totalTokens: 2500, cacheRead: 1920, totalCost: 0.0088, contextPercent: 6.1 });
  });

  it('parses cost emitted as a flat number (in-sandbox pricing)', () => {
    expect(
      runUsageTotal([
        event({
          seq: 1,
          type: 'usage',
          data: { usage: { tokens: { total: 52722 }, cost: 0.0347 } },
        }),
      ]),
    ).toMatchObject({ totalTokens: 52722, totalCost: 0.0347 });
  });

  it('returns null when no usage events are present', () => {
    expect(runUsageTotal([event({ seq: 1, data: { kind: 'text', text: 'hi' } })])).toBeNull();
  });
});
