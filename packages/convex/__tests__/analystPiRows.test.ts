import { describe, expect, it } from 'vitest';
import { toPiRunRows, type SandboxRunEventInput } from '../analystPiRows';

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

  it('collapses many usage snapshots into a single trailing summary', () => {
    const usage = (seq: number, total: number): SandboxRunEventInput =>
      event({ seq, type: 'usage', data: { usage: { tokens: { totalTokens: total } } } });

    const rows = toPiRunRows([
      usage(1, 100),
      event({ seq: 2, data: { kind: 'text', text: 'working' } }),
      usage(3, 250),
      usage(4, 380),
    ]);

    const usageRows = rows.filter((row) => row.kind === 'usage');
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({ kind: 'usage', usage: { totalTokens: 380 } });
    // The single usage summary always trails the work rows.
    expect(rows[rows.length - 1]?.kind).toBe('usage');
  });

  it('parses cost and context percent from a usage snapshot', () => {
    const [row] = toPiRunRows([
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
    ]);
    expect(row).toMatchObject({
      kind: 'usage',
      usage: { totalTokens: 2500, cacheRead: 1920, totalCost: 0.0088, contextPercent: 6.1 },
    });
  });

  it('never emits raw JSON for unstructured events', () => {
    const rows = toPiRunRows([event({ seq: 1, type: 'message', message: 'message_update' })]);
    expect(rows).toHaveLength(0);
  });
});
