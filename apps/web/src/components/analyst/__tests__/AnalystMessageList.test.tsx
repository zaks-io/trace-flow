// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalystMessageList, type AnalystMessage } from '../AnalystMessageList';

vi.mock('@convex-dev/agent/react', () => ({ useSmoothText: (text: string) => [text] }));

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
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
    status: 'success',
    text: '',
    parts: [],
    ...overrides,
  };
}

async function render(messages: AnalystMessage[], busy = false) {
  await act(async () => {
    root.render(
      <AnalystMessageList messages={messages} canLoadMore={false} loadMore={vi.fn()} busy={busy} />,
    );
  });
}

describe('Analyst chat messages', () => {
  it('keeps direct tool inputs, outputs, and the final answer visible and expandable', async () => {
    await render([
      message({
        text: 'Your agents used **1,234 tokens**.',
        parts: [
          {
            type: 'tool-get_usage_summary',
            toolCallId: 'usage-call',
            title: 'Usage summary',
            state: 'output-available',
            input: { period: 'last_7_days' },
            output: { totalTokens: 1234 },
          },
          { type: 'text', text: 'Your agents used **1,234 tokens**.', state: 'done' },
        ],
      }),
    ]);

    expect(container.textContent).toContain('Usage summary');
    expect(container.textContent).toContain('Input');
    expect(container.textContent).toContain('last_7_days');
    expect(container.textContent).toContain('Output');
    expect(container.textContent).toContain('1234');
    expect(container.querySelector('.analyst-markdown')?.textContent).toBe(
      'Your agents used 1,234 tokens.',
    );

    const button = container.querySelector('button')!;
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    await act(async () => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('last_7_days');
    expect(container.textContent).toContain('Your agents used');
  });

  it('shows a running dynamic tool and permits inspecting its input', async () => {
    await render(
      [
        message({
          status: 'streaming',
          parts: [
            {
              type: 'dynamic-tool',
              toolCallId: 'sessions-call',
              toolName: 'list_sessions',
              title: 'Sessions',
              state: 'input-available',
              input: { limit: 10 },
            },
          ],
        }),
      ],
      true,
    );
    expect(container.textContent).toContain('Sessions');
    expect(container.textContent).toContain('working');
    expect(container.textContent).toContain('Streaming');
    const button = container.querySelector('button')!;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await act(async () => button.click());
    expect(container.textContent).toContain('limit: 10');
  });

  it('keeps direct tool errors and failed message state visible', async () => {
    await render([
      message({
        status: 'failed',
        parts: [
          {
            type: 'dynamic-tool',
            toolCallId: 'failed-call',
            toolName: 'get_session',
            title: 'Session',
            state: 'output-error',
            input: { sessionId: 'missing' },
            errorText: 'Session could not be loaded',
          },
        ],
      }),
    ]);
    expect(container.textContent).toContain('Session could not be loaded');
    expect(container.textContent).toContain('Message failed');
    expect(container.textContent).not.toContain('working');
  });

  it('shows work after the latest prompt until the assistant has visible content', async () => {
    const user = message({
      id: 'user-1',
      key: 'user-1',
      role: 'user',
      order: 1,
      text: 'Show usage',
    });
    await render([user], true);
    expect(container.textContent).toContain('Analyst is working');
    await render([user, message({ text: 'Usage is ready' })], true);
    expect(container.textContent).not.toContain('Analyst is working');
    expect(container.textContent).toContain('Usage is ready');
  });

  it('omits redacted reasoning', async () => {
    await render([message({ parts: [{ type: 'reasoning', text: '[REDACTED]', state: 'done' }] })]);
    expect(container.textContent).not.toContain('[REDACTED]');
    expect(container.querySelector('button')).toBeNull();
  });
});
