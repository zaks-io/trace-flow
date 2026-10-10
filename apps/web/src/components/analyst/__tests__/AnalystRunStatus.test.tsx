// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '@trace-flow/convex/_generated/dataModel';
import {
  AnalystRunStatusBar,
  getAnalystRunState,
  type QueuedAnalystRun,
} from '../AnalystRunStatus';
import type { AnalystMessage } from '../analystMessageModel';

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
const threadId = 'thread_1' as Id<'analystThreads'>;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  environment.IS_REACT_ACT_ENVIRONMENT = false;
});

function message(overrides: Partial<AnalystMessage> = {}): AnalystMessage {
  return {
    _creationTime: 1,
    id: 'message-1',
    key: 'message-1',
    order: 2,
    stepOrder: 0,
    role: 'assistant',
    status: 'streaming',
    text: '',
    parts: [],
    ...overrides,
  };
}

function state(messages: AnalystMessage[], queuedRun: QueuedAnalystRun | null = null) {
  return getAnalystRunState({ sending: false, currentThreadId: threadId, queuedRun, messages });
}

describe('Analyst chat run state', () => {
  it('keeps accepted messages busy until streaming begins or the queued answer completes', () => {
    const queuedRun = { threadId, afterOrder: 1 };
    expect(state([], queuedRun)).toMatchObject({ phase: 'queued', busy: true });
    expect(state([message()], queuedRun)).toMatchObject({ phase: 'running', busy: true });
    expect(state([message({ status: 'success', text: 'Done' })], queuedRun)).toMatchObject({
      phase: 'idle',
      busy: false,
    });
  });

  it('tracks pending stream startup and releases content-bearing pending messages', () => {
    expect(state([message({ status: 'pending' })])).toMatchObject({ phase: 'running', busy: true });
    expect(state([message({ status: 'pending', text: 'Finished answer.' })])).toMatchObject({
      phase: 'idle',
      busy: false,
    });
  });

  it('reports active direct tools without treating completed tool errors as running tools', () => {
    const part = {
      type: 'dynamic-tool' as const,
      toolCallId: 'usage-call',
      toolName: 'get_usage_summary',
      title: 'Usage summary',
      state: 'input-available' as const,
      input: {},
    };
    expect(state([message({ parts: [part] })]).detail).toBe('Running Usage summary.');
    expect(
      state([message({ parts: [{ ...part, state: 'output-error', errorText: 'Failed' }] })]).detail,
    ).toBe('Streaming the Analyst response.');
  });

  it('makes queued and streaming runs stoppable, disabling repeated stops while stopping', async () => {
    const onStop = vi.fn();
    for (const runState of [state([], { threadId, afterOrder: 1 }), state([message()])]) {
      await act(async () => root.render(<AnalystRunStatusBar state={runState} onStop={onStop} />));
      const button = container.querySelector<HTMLButtonElement>('[aria-label="Stop Analyst run"]')!;
      expect(button.disabled).toBe(false);
      button.focus();
      expect(document.activeElement).toBe(button);
      expect(button.title).toBe('Up to 50 steps per run');
      await act(async () => button.click());
    }
    expect(onStop).toHaveBeenCalledTimes(2);
    await act(async () => {
      root.render(<AnalystRunStatusBar state={state([message()])} onStop={onStop} stopping />);
    });
    expect(container.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
  });

  it('ends busy and stop state after completion or failure', async () => {
    const onStop = vi.fn();
    for (const status of ['success', 'failed'] as const) {
      const runState = state([message({ status, text: 'Finished' })]);
      expect(runState.busy).toBe(false);
      await act(async () => root.render(<AnalystRunStatusBar state={runState} onStop={onStop} />));
      expect(container.querySelector('button')).toBeNull();
    }
    expect(container.textContent).toContain('Failed');
  });
});
