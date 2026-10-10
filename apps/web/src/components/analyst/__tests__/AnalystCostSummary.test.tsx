// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '@trace-flow/convex/_generated/dataModel';
import { AnalystCostSummary } from '../AnalystCostSummary';

const hooks = vi.hoisted(() => ({ useQuery: vi.fn(), useIsAdmin: vi.fn() }));
vi.mock('convex/react', () => ({ useQuery: hooks.useQuery }));
vi.mock('@/components/admin/AdminContext', () => ({ useIsAdmin: hooks.useIsAdmin }));

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  hooks.useIsAdmin.mockReturnValue(true);
  hooks.useQuery.mockReturnValue(undefined);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  environment.IS_REACT_ACT_ENVIRONMENT = false;
});

async function render() {
  await act(async () =>
    root.render(<AnalystCostSummary threadId={'thread_1' as Id<'analystThreads'>} />),
  );
}

describe('Analyst conversation usage', () => {
  it('shows the Analyst tokens and cost with a matching total', async () => {
    hooks.useQuery.mockReturnValue({
      analyst: { totalTokens: 1234, totalCost: 0.0025, hasCost: true },
    });
    await render();
    const rows = Array.from(container.querySelectorAll('tbody tr, tfoot tr'));
    expect(rows.map((row) => row.textContent)).toEqual(['Analyst1.2K$0.0025', 'Total1.2K$0.0025']);
  });

  it('keeps token usage visible without inventing an unavailable dollar amount', async () => {
    hooks.useQuery.mockReturnValue({ analyst: { totalTokens: 25, totalCost: 0, hasCost: false } });
    await render();
    expect(container.querySelector('tbody tr')?.textContent).toBe('Analyst25—');
    expect(container.textContent).not.toContain('$');
  });

  it('does not show an empty ledger or load usage for non-admins', async () => {
    hooks.useQuery.mockReturnValue({ analyst: { totalTokens: 0, totalCost: 0, hasCost: false } });
    await render();
    expect(container.querySelector('table')).toBeNull();
    hooks.useIsAdmin.mockReturnValue(false);
    await render();
    expect(hooks.useQuery.mock.calls.at(-1)?.[1]).toBe('skip');
    expect(container.querySelector('table')).toBeNull();
  });
});
