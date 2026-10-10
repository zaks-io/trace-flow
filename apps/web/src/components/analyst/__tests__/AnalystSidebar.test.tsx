// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getFunctionName } from 'convex/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalystMessage } from '../analystMessageModel';
import { AnalystSidebar } from '../AnalystSidebar';

const hooks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  useAction: vi.fn(),
  useUIMessages: vi.fn(),
  stopRun: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock('convex/react', () => ({ useQuery: hooks.useQuery, useAction: hooks.useAction }));
vi.mock('@convex-dev/agent/react', () => ({
  useUIMessages: hooks.useUIMessages,
  useSmoothText: (text: string) => [text],
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/app/usage' }));
vi.mock('@/components/admin/AdminContext', () => ({ useIsAdmin: () => false }));
vi.mock('../AnalystContext', () => ({
  useAnalyst: () => ({
    open: true,
    setOpen: vi.fn(),
    currentThreadId: 'thread_1',
    selectThread: vi.fn(),
    selectedReferences: [],
    removeReference: vi.fn(),
    clearReferences: vi.fn(),
    selectionMode: false,
    setSelectionMode: vi.fn(),
  }),
}));
vi.mock('../useResizableSidebar', () => ({
  useResizableSidebar: () => ({ width: 400, resizing: false, handleProps: {} }),
}));

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  hooks.useQuery.mockImplementation((reference) => {
    const name = getFunctionName(reference);
    if (name === 'analyst:listThreads') return [{ _id: 'thread_1', title: 'Usage', updatedAt: 1 }];
    if (name === 'analyst:conversationUsageSummary') return undefined;
    throw new Error(`Unexpected sidebar query: ${name}`);
  });
  hooks.useAction.mockImplementation((reference) => {
    const name = getFunctionName(reference);
    if (name === 'analyst:stopRun') return hooks.stopRun;
    if (name === 'analyst:sendMessage') return hooks.sendMessage;
    throw new Error(`Unexpected sidebar action: ${name}`);
  });
  hooks.stopRun.mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  environment.IS_REACT_ACT_ENVIRONMENT = false;
});

async function render(status: AnalystMessage['status']) {
  hooks.useUIMessages.mockReturnValue({
    results: [
      {
        _creationTime: 1,
        id: 'answer',
        key: 'answer',
        order: 2,
        stepOrder: 0,
        role: 'assistant',
        status,
        text: 'Analyzing usage',
        parts: [],
      },
    ],
    status: 'Exhausted',
    loadMore: vi.fn(),
  });
  await act(async () => root.render(<AnalystSidebar />));
}

describe('Analyst sidebar composer', () => {
  it('stops a streaming chat through the chat action and restores Send after completion', async () => {
    await render('streaming');
    const stop = container.querySelector<HTMLButtonElement>(
      'footer [aria-label="Stop Analyst run"]',
    )!;
    expect(stop.disabled).toBe(false);
    await act(async () => stop.click());
    expect(hooks.stopRun).toHaveBeenCalledWith({ threadId: 'thread_1' });
    expect(hooks.sendMessage).not.toHaveBeenCalled();

    await render('success');
    expect(container.querySelector('footer [aria-label="Stop Analyst run"]')).toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled,
    ).toBe(true);
  });

  it('shows a stop error and permits retrying without sending another prompt', async () => {
    hooks.stopRun.mockRejectedValueOnce(new Error('Could not stop this response'));
    await render('streaming');
    const stop = container.querySelector<HTMLButtonElement>(
      'footer [aria-label="Stop Analyst run"]',
    )!;
    await act(async () => stop.click());
    expect(container.textContent).toContain('Could not stop this response');
    expect(stop.disabled).toBe(false);
    await act(async () => stop.click());
    expect(hooks.stopRun).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('Could not stop this response');
  });
});
