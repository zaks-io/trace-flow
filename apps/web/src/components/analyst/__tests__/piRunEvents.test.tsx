import { describe, expect, it } from 'vitest';
import { ANALYST_MAX_STEPS, getAnalystRunState } from '../AnalystRunStatus';
import { buildFallbackRun, runtimeLabel, type PiAgentStartOutput } from '../piRunEvents';

const startOutput = (over: Partial<PiAgentStartOutput>): PiAgentStartOutput => ({
  type: 'async_pi_agent_run',
  ...over,
});

describe('buildFallbackRun', () => {
  it('marks a fallback run failed when a start reported an error but no status', () => {
    const run = buildFallbackRun('run_x' as never, startOutput({ error: 'launch refused' }), 1_000);
    expect(run.status).toBe('failed');
    expect(run.error).toBe('launch refused');
  });

  it('marks a fallback run failed when ok is false', () => {
    const run = buildFallbackRun('run_x' as never, startOutput({ ok: false }), 1_000);
    expect(run.status).toBe('failed');
  });

  it('defaults a clean start with no status to running', () => {
    const run = buildFallbackRun('run_x' as never, startOutput({ ok: true }), 1_000);
    expect(run.status).toBe('running');
  });
});

// Pi run-event → row mapping moved server-side; its tests live in
// packages/convex/__tests__/analystPiRows.test.ts. What stays here is the
// client-only run state (timeout labels, composer busy state).

describe('runtimeLabel', () => {
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
});

describe('getAnalystRunState', () => {
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
    expect(state.label).toBe('Analyzing');
    expect(state.busy).toBe(false);
  });
});
