import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalystMessage } from '../AnalystMessageList';
import { AnalystMessageList } from '../AnalystMessageList';
import { ANALYST_MAX_STEPS, AnalystRunStatusBar, getAnalystRunState } from '../AnalystRunStatus';
import {
  formatRunEvent,
  runtimeLabel,
  type SandboxRun,
  type SandboxRunEvent,
} from '../AnalystSandboxRuns';

const convexMocks = vi.hoisted(() => ({
  useAction: vi.fn(),
  useQuery: vi.fn(),
}));

vi.mock('convex/react', () => ({
  useAction: convexMocks.useAction,
  useQuery: convexMocks.useQuery,
}));

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <p>{children}</p>,
}));

beforeEach(() => {
  convexMocks.useAction.mockReset();
  convexMocks.useAction.mockReturnValue(vi.fn());
  convexMocks.useQuery.mockReset();
});

function renderMessage(
  parts: AnalystMessage['parts'],
  status: AnalystMessage['status'] = 'success',
) {
  const message = {
    _creationTime: 1,
    id: 'message-1',
    key: 'message-1',
    order: 1,
    parts,
    role: 'assistant',
    status,
    stepOrder: 0,
    text: '',
  } satisfies AnalystMessage;

  return renderToStaticMarkup(
    <AnalystMessageList messages={[message]} canLoadMore={false} loadMore={() => undefined} />,
  );
}

describe('AnalystMessageList', () => {
  it('renders reasoning as readable text without provider metadata JSON', () => {
    const html = renderMessage([
      {
        type: 'reasoning',
        text: 'The user asked about costs, so inspect usage.',
        state: 'done',
        providerMetadata: {
          openrouter: {
            provider: 'Novita',
          },
        },
      },
    ]);

    expect(html).toContain('Reasoning');
    expect(html).toContain('The user asked about costs, so inspect usage.');
    expect(html).not.toContain('providerMetadata');
    expect(html).not.toContain('openrouter');
    expect(html).not.toContain('{&quot;');
  });

  it('renders text parts as message text', () => {
    const html = renderMessage([{ type: 'text', text: 'Hi from the Analyst.', state: 'done' }]);

    expect(html).toContain('Hi from the Analyst.');
  });

  it('renders tool state and output without dumping the full part object', () => {
    const html = renderMessage([
      {
        type: 'tool-run_python_analysis',
        toolCallId: 'tool-1',
        state: 'output-available',
        input: { question: 'costs' },
        output: { answer: 4 },
      },
    ]);

    expect(html).toContain('run_python_analysis');
    expect(html).toContain('output-available');
    expect(html).toContain('answer: 4');
    expect(html).not.toContain('toolCallId');
    expect(html).not.toContain('{&quot;');
  });

  it('does not render unknown parts as raw JSON', () => {
    const html = renderMessage([
      {
        type: 'provider-debug',
        providerMetadata: {
          openrouter: {
            provider: 'Novita',
          },
        },
      } as never,
    ]);

    expect(html).not.toContain('provider-debug');
    expect(html).not.toContain('providerMetadata');
    expect(html).not.toContain('openrouter');
    expect(html).not.toContain('{&quot;');
  });

  it('filters hidden internal Analyst messages', () => {
    const hidden = {
      _creationTime: 1,
      id: 'hidden-message',
      key: 'hidden-message',
      order: 1,
      parts: [{ type: 'text', text: 'Internal Pi continuation prompt.', state: 'done' }],
      metadata: {
        providerMetadata: {
          traceFlowAnalyst: {
            hidden: true,
          },
        },
      },
      role: 'user',
      status: 'success',
      stepOrder: 0,
      text: 'Internal Pi continuation prompt.',
    } satisfies AnalystMessage;
    const visible = {
      _creationTime: 2,
      id: 'visible-message',
      key: 'visible-message',
      order: 2,
      parts: [{ type: 'text', text: 'Visible human prompt.', state: 'done' }],
      role: 'user',
      status: 'success',
      stepOrder: 0,
      text: 'Visible human prompt.',
    } satisfies AnalystMessage;

    const html = renderToStaticMarkup(
      <AnalystMessageList
        messages={[hidden, visible]}
        canLoadMore={false}
        loadMore={() => undefined}
      />,
    );

    expect(html).toContain('Visible human prompt.');
    expect(html).not.toContain('Internal Pi continuation prompt.');
  });

  it('filters Pi completion continuation prompts without hidden metadata', () => {
    const hidden = {
      _creationTime: 1,
      id: 'pi-continuation',
      key: 'pi-continuation',
      order: 1,
      parts: [
        {
          type: 'text',
          text: 'A background Pi coding-agent analysis completed. Use this final composed response to answer the user.',
          state: 'done',
        },
      ],
      role: 'user',
      status: 'success',
      stepOrder: 0,
      text: 'A background Pi coding-agent analysis completed. Use this final composed response to answer the user.',
    } satisfies AnalystMessage;
    const visible = {
      _creationTime: 2,
      id: 'visible-human',
      key: 'visible-human',
      order: 2,
      parts: [
        {
          type: 'text',
          text: 'Can you explain the latest Pi data analysis run?',
          state: 'done',
        },
      ],
      role: 'user',
      status: 'success',
      stepOrder: 0,
      text: 'Can you explain the latest Pi data analysis run?',
    } satisfies AnalystMessage;

    const html = renderToStaticMarkup(
      <AnalystMessageList
        messages={[hidden, visible]}
        canLoadMore={false}
        loadMore={() => undefined}
      />,
    );

    expect(html).toContain('Can you explain the latest Pi data analysis run?');
    expect(html).not.toContain('A background Pi coding-agent analysis completed.');
  });

  it('renders pending messages as visible activity instead of an empty bubble', () => {
    const html = renderMessage([], 'pending');

    expect(html).toContain('Waiting for stream');
  });

  it('does not show stale pending activity when the message has content', () => {
    const html = renderMessage(
      [{ type: 'text', text: 'Finished answer.', state: 'done' }],
      'pending',
    );

    expect(html).toContain('Finished answer.');
    expect(html).not.toContain('Waiting for stream');
  });

  it('renders streaming tool calls as running activity', () => {
    const html = renderMessage(
      [
        {
          type: 'tool-run_python_analysis',
          toolCallId: 'tool-1',
          state: 'input-available',
          input: { question: 'costs' },
        },
      ],
      'streaming',
    );

    expect(html).toContain('run_python_analysis');
    expect(html).toContain('input-available');
    expect(html).toContain('Streaming');
  });

  it('shows a working indicator after the latest visible user prompt while busy', () => {
    const message = {
      _creationTime: 1,
      id: 'message-1',
      key: 'message-1',
      order: 1,
      parts: [{ type: 'text', text: 'Tell me about usage.', state: 'done' }],
      role: 'user',
      status: 'success',
      stepOrder: 0,
      text: 'Tell me about usage.',
    } satisfies AnalystMessage;

    const html = renderToStaticMarkup(
      <AnalystMessageList
        messages={[message]}
        canLoadMore={false}
        loadMore={() => undefined}
        busy
      />,
    );

    expect(html).toContain('Analyst is working');
  });

  it('renders Pi analysis inline from the known tool output shape', () => {
    const runId = 'run_1234567890abcdef' as never;
    const now = Date.now();
    const run = {
      _id: runId,
      _creationTime: now,
      status: 'running',
      updatedAt: now,
      startedAt: now,
      maxRuntimeMs: 10 * 60_000,
    } satisfies SandboxRun;
    const events = [
      {
        _id: 'event_1' as never,
        seq: 1,
        type: 'tool_call',
        message: 'query_usage_metrics',
        emittedAt: now,
      },
      {
        _id: 'event_2' as never,
        seq: 2,
        type: 'stdout',
        message: 'message_update',
        data: {
          event: JSON.stringify({
            type: 'message_update',
            assistantMessageEvent: {
              type: 'text_delta',
              delta: 'I am checking usage totals.',
            },
          }),
        },
        emittedAt: now,
      },
    ] satisfies SandboxRunEvent[];

    convexMocks.useQuery.mockImplementation((_query, args) => {
      if (args && typeof args === 'object' && 'limit' in args) return events;
      if (args && typeof args === 'object' && 'runId' in args) return run;
      return undefined;
    });

    const html = renderMessage([
      {
        type: 'tool-start_pi_agent_analysis',
        toolCallId: 'tool-1',
        state: 'output-available',
        input: { prompt: 'tell me about my usage' },
        output: {
          ok: true,
          type: 'async_pi_agent_run',
          async: true,
          runId,
          status: 'running',
          maxRuntimeMinutes: 10,
          message: 'Pi data analysis started.',
        },
      },
    ]);

    expect(html).toContain('Pi analysis');
    expect(html).toContain('start_pi_agent_analysis');
    expect(html).toContain('running');
    expect(html).toContain('max 10m');
    expect(html).toContain('Pi data analysis started.');
    expect(html).toContain('Calling query_usage_metrics');
    expect(html).toContain('I am checking usage totals.');
    expect(html).not.toContain('runId:');
    expect(html).not.toContain('message_update');
    expect(html).not.toContain('{&quot;');
  });

  it('renders Pi heartbeat and usage as a live status summary', () => {
    const runId = 'run_heartbeat_1234567890abcdef' as never;
    const now = Date.now();
    const run = {
      _id: runId,
      _creationTime: now,
      status: 'running',
      updatedAt: now,
      startedAt: now,
      maxRuntimeMs: 15 * 60_000,
      nextSeq: 4,
    } satisfies SandboxRun;
    const events = [
      {
        _id: 'event_1' as never,
        seq: 1,
        type: 'status',
        message: 'Pi runtime configured',
        data: {
          projectTrusted: true,
          discovery: {
            extensions: false,
            skills: false,
            promptTemplates: false,
            themes: false,
            contextFiles: false,
          },
        },
        emittedAt: now,
      },
      {
        _id: 'event_2' as never,
        seq: 2,
        type: 'status',
        message: 'Pi runner heartbeat',
        data: {
          phase: 'tool_execution_end',
          latestToolName: 'traceflow_data',
          idleMs: 12_000,
          piEventCount: 7,
          resultTextChars: 321,
        },
        emittedAt: now,
      },
      {
        _id: 'event_3' as never,
        seq: 3,
        type: 'usage',
        message: 'Pi usage updated',
        data: {
          usage: {
            tokens: { totalTokens: 1500, cacheRead: 100 },
            cost: { total: 0.0042 },
          },
        },
        emittedAt: now,
      },
    ] satisfies SandboxRunEvent[];

    convexMocks.useQuery.mockImplementation((_query, args) => {
      if (args && typeof args === 'object' && 'limit' in args) return events;
      if (args && typeof args === 'object' && 'runId' in args) return run;
      return undefined;
    });

    const html = renderMessage([
      {
        type: 'tool-start_pi_agent_analysis',
        toolCallId: 'tool-1',
        state: 'output-available',
        input: { prompt: 'tell me about my data' },
        output: {
          ok: true,
          type: 'async_pi_agent_run',
          async: true,
          runId,
          status: 'running',
          maxRuntimeMinutes: 15,
          message: 'Pi data analysis started.',
        },
      },
    ]);

    expect(html).toContain('phase tool execution end');
    expect(html).toContain('tool traceflow_data');
    expect(html).toContain('idle 12s');
    expect(html).toContain('7 Pi events');
    expect(html).toContain('usage 1,500 tokens, 100 cached, $0.0042');
    expect(html).toContain('trusted generated workspace, ambient Pi discovery disabled');
    expect(html).not.toContain('Pi runner heartbeat');
  });

  it('ages out stale Pi inline fallback output when the run query is unavailable', () => {
    const runId = 'run_stale_1234567890' as never;
    const events = [
      {
        _id: 'event_stale_1' as never,
        seq: 1,
        type: 'stdout',
        message: 'last observed output',
        emittedAt: Date.now() - 20 * 60_000,
      },
    ] satisfies SandboxRunEvent[];

    convexMocks.useQuery.mockImplementation((_query, args) => {
      if (args && typeof args === 'object' && 'limit' in args) return events;
      return undefined;
    });

    const html = renderMessage([
      {
        type: 'tool-start_pi_agent_analysis',
        toolCallId: 'tool-1',
        state: 'output-available',
        input: { prompt: 'tell me about my usage' },
        output: {
          ok: true,
          type: 'async_pi_agent_run',
          async: true,
          runId,
          status: 'running',
          maxRuntimeMinutes: 10,
          message: 'Pi data analysis started.',
        },
      },
    ]);

    expect(html).toContain('timed out');
    expect(html).toContain('Run exceeded its configured max runtime');
    expect(html).not.toContain('animate-spin');
  });

  it('times out active Pi runs from their start deadline even with recent output', () => {
    const startedAt = 1_000;
    const runId = 'run_started_deadline_123' as never;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(startedAt + 10 * 60_000 + 31_000);
    const run = {
      _id: runId,
      _creationTime: startedAt,
      status: 'running',
      updatedAt: startedAt + 9 * 60_000,
      startedAt,
      lastEventAt: startedAt + 9 * 60_000,
      maxRuntimeMs: 10 * 60_000,
    } satisfies SandboxRun;
    const events = [
      {
        _id: 'event_recent_1' as never,
        seq: 1,
        type: 'stdout',
        message: 'recent streamed output',
        emittedAt: startedAt + 9 * 60_000,
      },
    ] satisfies SandboxRunEvent[];

    convexMocks.useQuery.mockImplementation((_query, args) => {
      if (args && typeof args === 'object' && 'limit' in args) return events;
      if (args && typeof args === 'object' && 'runId' in args) return run;
      return undefined;
    });

    try {
      const html = renderMessage([
        {
          type: 'tool-start_pi_agent_analysis',
          toolCallId: 'tool-1',
          state: 'output-available',
          input: { prompt: 'tell me about my usage' },
          output: {
            ok: true,
            type: 'async_pi_agent_run',
            async: true,
            runId,
            status: 'running',
            maxRuntimeMinutes: 10,
            message: 'Pi data analysis started.',
          },
        },
      ]);

      expect(html).toContain('timed out');
      expect(html).toContain('Run exceeded its configured max runtime');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('formats active runtime labels from an injected clock', () => {
    expect(
      runtimeLabel(
        {
          _id: 'run_timer_label' as never,
          _creationTime: 1_000,
          status: 'running',
          updatedAt: 1_000,
          startedAt: 1_000,
          maxRuntimeMs: 10 * 60_000,
        },
        4_000,
      ),
    ).toBe('3s elapsed, max 10m');
  });

  it('renders a completed Pi result once when the final run text is available', () => {
    const runId = 'run_completed_1234567890' as never;
    const finalText = 'Unique Pi final result.';
    const run = {
      _id: runId,
      _creationTime: 1,
      status: 'completed',
      updatedAt: 1,
      startedAt: 1,
      completedAt: 2,
      maxRuntimeMs: 3 * 60_000,
      resultText: finalText,
    } satisfies SandboxRun;
    const events = [
      {
        _id: 'event_1' as never,
        seq: 1,
        type: 'result',
        message: finalText,
        emittedAt: 2,
      },
    ] satisfies SandboxRunEvent[];

    convexMocks.useQuery.mockImplementation((_query, args) => {
      if (args && typeof args === 'object' && 'limit' in args) return events;
      if (args && typeof args === 'object' && 'runId' in args) return run;
      return undefined;
    });

    const html = renderMessage([
      {
        type: 'tool-start_pi_agent_analysis',
        toolCallId: 'tool-1',
        state: 'output-available',
        input: { prompt: 'summarize data' },
        output: {
          ok: true,
          type: 'async_pi_agent_run',
          async: true,
          runId,
          status: 'completed',
          maxRuntimeMinutes: 3,
          message: 'Pi data analysis started.',
        },
      },
    ]);

    expect(html.match(new RegExp(finalText, 'g'))).toHaveLength(1);
  });
});

describe('Analyst sandbox run events', () => {
  it('formats stored Pi message updates as readable activity', () => {
    const formatted = formatRunEvent({
      _id: 'event_1' as never,
      seq: 1,
      type: 'stdout',
      message: 'message_update',
      data: {
        event: JSON.stringify({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'text_delta',
            delta: 'Reading usage buckets.',
          },
        }),
      },
      emittedAt: 1,
    });

    expect(formatted).toMatchObject({
      label: 'Pi',
      text: 'Reading usage buckets.',
    });
  });

  it('formats Pi thinking deltas as reasoning text', () => {
    const formatted = formatRunEvent({
      _id: 'event_1' as never,
      seq: 1,
      type: 'stdout',
      message: 'message_update',
      data: {
        event: JSON.stringify({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'thinking_delta',
            delta: 'Planning the data queries.',
          },
        }),
      },
      emittedAt: 1,
    });

    expect(formatted).toMatchObject({
      label: 'Reasoning',
      text: 'Planning the data queries.',
    });
  });

  it('formats Pi turn-end message content as visible analysis text', () => {
    const formatted = formatRunEvent({
      _id: 'event_1' as never,
      seq: 1,
      type: 'message',
      message: 'turn_end',
      data: {
        event: JSON.stringify({
          type: 'turn_end',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'thinking',
                thinking: 'Internal plan',
              },
              {
                type: 'text',
                text: 'The trace data is empty, but agent analytics has usable data.',
              },
            ],
          },
        }),
      },
      emittedAt: 1,
    });

    expect(formatted).toMatchObject({
      label: 'Pi',
      text: 'The trace data is empty, but agent analytics has usable data.',
    });
  });

  it('formats Pi tool execution and usage events without raw JSON', () => {
    const toolStart = formatRunEvent({
      _id: 'event_1' as never,
      seq: 1,
      type: 'message',
      message: 'tool started',
      data: {
        event: JSON.stringify({
          type: 'tool_execution_start',
          toolName: 'traceflow_data',
        }),
      },
      emittedAt: 1,
    });
    const usage = formatRunEvent({
      _id: 'event_2' as never,
      seq: 2,
      type: 'usage',
      message: 'Pi usage updated',
      data: {
        usage: {
          tokens: { totalTokens: 2500 },
          cost: { total: 0.0088 },
        },
      },
      emittedAt: 2,
    });

    expect(toolStart).toMatchObject({
      label: 'Tool',
      text: 'traceflow_data started',
    });
    expect(usage).toMatchObject({
      label: 'Usage',
      text: 'usage 2,500 tokens, $0.0088',
    });
  });

  it('hides Pi tool-call JSON deltas because data query events render the tool activity', () => {
    const formatted = formatRunEvent({
      _id: 'event_1' as never,
      seq: 1,
      type: 'stdout',
      message: '{"toolName":"get_usage_summary","arguments":"{}"}',
      data: {
        event: JSON.stringify({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'text_delta',
            delta: '{"toolName":"get_usage_summary","arguments":"{}"}',
          },
        }),
      },
      emittedAt: 1,
    });

    expect(formatted).toBeNull();
  });

  it('summarizes Trace Flow data results instead of rendering the full payload', () => {
    const formatted = formatRunEvent({
      _id: 'event_1' as never,
      seq: 1,
      type: 'message',
      message: 'tool completed',
      data: {
        event: JSON.stringify({
          type: 'tool_execution_end',
          toolName: 'traceflow_data',
          result: {
            isError: false,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        summary: {
                          request_count: 12,
                          error_count: 1,
                          tokens: { total: 3456 },
                          cost_usd: { total: 0.0123 },
                        },
                      }),
                    },
                  ],
                }),
              },
            ],
          },
        }),
      },
      emittedAt: 1,
    });

    expect(formatted).toMatchObject({
      label: 'Data result',
      text: 'traceflow_data: 12 requests, 1 errors, 3,456 tokens, $0.01',
    });
    expect(formatted?.text).not.toContain('request_count');
  });

  it('hides Pi lifecycle events that do not contain analysis content', () => {
    const messageStart = formatRunEvent({
      _id: 'event_1' as never,
      seq: 1,
      type: 'message',
      message: 'message_start',
      data: {
        event: JSON.stringify({
          type: 'message_start',
        }),
      },
      emittedAt: 1,
    });

    const textEnd = formatRunEvent({
      _id: 'event_2' as never,
      seq: 2,
      type: 'stdout',
      message: 'message_update',
      data: {
        event: JSON.stringify({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'text_end',
          },
        }),
      },
      emittedAt: 2,
    });

    const structuredAgentEnd = formatRunEvent({
      _id: 'event_3' as never,
      seq: 3,
      type: 'stdout',
      message: 'agent_end',
      data: {
        eventType: 'agent_end',
      },
      emittedAt: 3,
    });

    expect(messageStart).toBeNull();
    expect(textEnd).toBeNull();
    expect(structuredAgentEnd).toBeNull();
  });
});

describe('Analyst run status', () => {
  const threadId = 'thread_1' as never;

  it('shows the configured max step count', () => {
    expect(ANALYST_MAX_STEPS).toBe(50);
  });

  it('reports queued after submit before stream deltas arrive', () => {
    const state = getAnalystRunState({
      sending: false,
      currentThreadId: threadId,
      queuedRun: { threadId, afterOrder: 1 },
      messages: [],
    });

    expect(state.phase).toBe('queued');
    expect(state.busy).toBe(true);
  });

  it('reports running when Convex Agent exposes pending or streaming messages', () => {
    const state = getAnalystRunState({
      sending: false,
      currentThreadId: threadId,
      queuedRun: null,
      messages: [
        {
          _creationTime: 1,
          id: 'message-1',
          key: 'message-1',
          order: 2,
          parts: [],
          role: 'assistant',
          status: 'streaming',
          stepOrder: 0,
          text: '',
        },
      ],
    });

    expect(state.phase).toBe('running');
    expect(state.busy).toBe(true);
  });

  it('does not stay running for a content-bearing pending message', () => {
    const state = getAnalystRunState({
      sending: false,
      currentThreadId: threadId,
      queuedRun: null,
      messages: [
        {
          _creationTime: 1,
          id: 'message-1',
          key: 'message-1',
          order: 2,
          parts: [{ type: 'text', text: 'Finished answer.', state: 'done' }],
          role: 'assistant',
          status: 'pending',
          stepOrder: 0,
          text: 'Finished answer.',
        },
      ],
    });

    expect(state.phase).toBe('idle');
    expect(state.busy).toBe(false);
  });

  it('reports background Pi runs without blocking the composer', () => {
    const state = getAnalystRunState({
      sending: false,
      currentThreadId: threadId,
      queuedRun: null,
      messages: [
        {
          _creationTime: 1,
          id: 'message-1',
          key: 'message-1',
          order: 2,
          parts: [{ type: 'text', text: 'Pi run started.', state: 'done' }],
          role: 'assistant',
          status: 'success',
          stepOrder: 0,
          text: 'Pi run started.',
        },
      ],
      sandboxRuns: [{ status: 'running' }],
    });

    expect(state.phase).toBe('background');
    expect(state.label).toBe('Pi Running');
    expect(state.busy).toBe(false);
  });

  it('renders a stop button for an active Analyst run', () => {
    const html = renderToStaticMarkup(
      <AnalystRunStatusBar
        state={{
          phase: 'running',
          label: 'Running',
          detail: 'Streaming the Analyst response.',
          busy: true,
        }}
        onStop={() => undefined}
      />,
    );

    expect(html).toContain('Stop');
    expect(html).toContain('Stop Analyst run');
  });
});

describe('Analyst sidebar layout', () => {
  it('keeps the open panel in layout flow instead of fixed overlay', () => {
    const sidebarPath = fileURLToPath(new URL('../AnalystSidebar.tsx', import.meta.url));
    const layoutPath = fileURLToPath(
      new URL('../../../app/app/AppLayoutClient.tsx', import.meta.url),
    );
    const sandboxRunsPath = fileURLToPath(new URL('../AnalystSandboxRuns.tsx', import.meta.url));
    const sidebarSource = readFileSync(sidebarPath, 'utf8');
    const layoutSource = readFileSync(layoutPath, 'utf8');
    const sandboxRunsSource = readFileSync(sandboxRunsPath, 'utf8');

    expect(sidebarSource).toContain('flex h-full w-[420px] shrink-0');
    expect(sidebarSource).not.toContain('fixed inset-y-0 right-0');
    expect(sidebarSource).not.toContain('<AnalystSandboxRuns');
    expect(sidebarSource).toContain(
      'onClick={canStopAnalyst ? () => void handleStop() : () => void handleSend()}',
    );
    expect(sidebarSource).toContain(
      "aria-label={canStopAnalyst ? 'Stop Analyst run' : 'Send message'}",
    );
    expect(sidebarSource).toContain('messageScrollRef');
    expect(sidebarSource).toContain('element.scrollTop = element.scrollHeight');
    expect(sidebarSource).toContain('latestRun?.nextSeq');
    expect(sandboxRunsSource).toContain('eventListRef');
    expect(sandboxRunsSource).toContain('resultRef');
    expect(sandboxRunsSource).toContain('latestFormattedEventKey');
    expect(layoutSource.indexOf('<SidebarInset>')).toBeLessThan(
      layoutSource.indexOf('<AnalystSidebar />'),
    );
    expect(layoutSource.indexOf('<AnalystSidebar />')).toBeLessThan(
      layoutSource.indexOf('</SidebarProvider>'),
    );
  });
});
