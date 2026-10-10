// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import type { Preloaded } from 'convex/react';
import { api } from '@trace-flow/convex/_generated/api';
import type { Doc } from '@trace-flow/convex/_generated/dataModel';
import { SidebarProvider } from '@/components/ui/sidebar';
import ApiKeys from '../ApiKeys';

const mocks = vi.hoisted(() => ({
  keys: [] as Doc<'apiKeys'>[],
  update: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('convex/react', () => ({
  usePreloadedQuery: () => mocks.keys,
  useQuery: () => ({ user: { enabled: true } }),
  useMutation: (reference: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(reference);
    if (name === 'apiKeys:update') return mocks.update;
    if (name === 'apiKeys:create') return mocks.create;
    if (name === 'apiKeys:remove') return mocks.remove;
    throw new Error(`Unexpected mutation ${name}`);
  },
}));

vi.mock('@/hooks/useDefaultApiKey', () => ({
  useDefaultApiKey: () => ({
    primaryApiKey: mocks.keys[0] ?? null,
    isCreatingDefaultKey: false,
    defaultKeyError: null,
  }),
}));

let container: HTMLDivElement;
let root: Root;
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeEach(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  mocks.update.mockReset().mockResolvedValue(null);
  mocks.create.mockReset().mockResolvedValue('created-key');
  mocks.remove.mockReset().mockResolvedValue(null);
  mocks.keys = [
    {
      _id: 'test-key' as Doc<'apiKeys'>['_id'],
      _creationTime: Date.now(),
      key: 'test-ingest-key',
      permissions: ['ingest'],
      name: 'Production',
      expiresAt: Date.now() + 90 * 86_400_000,
    },
  ];
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  environment.IS_REACT_ACT_ENVIRONMENT = false;
});

async function render() {
  await act(async () => {
    root.render(
      <SidebarProvider>
        <ApiKeys preloadedApiKeys={{} as Preloaded<typeof api.apiKeys.list>} />
      </SidebarProvider>,
    );
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}

describe('API keys controls', () => {
  it('shows create, edit, and delete for ingest keys without a sync control', async () => {
    await render();
    expect(container.querySelector('tbody')?.textContent).toContain('Production');
    expect(
      [...container.querySelectorAll('button')].some((element) =>
        /sync/i.test(element.textContent ?? ''),
      ),
    ).toBe(false);
    expect(container.textContent).not.toContain('Sync to KV');
    button('Create API Key').focus();
    expect(document.activeElement).toBe(button('Create API Key'));
    expect(button('Delete').disabled).toBe(false);
    await act(async () => button('Edit').click());
    expect(container.querySelector<HTMLInputElement>('#editKeyName')?.value).toBe('Production');
    await act(async () => button('Save').click());
    expect(mocks.update).toHaveBeenCalledWith({
      id: 'test-key',
      name: 'Production',
      expiresAt: mocks.keys[0].expiresAt,
    });
    expect(container.textContent).toContain('API key updated successfully');
  });

  it('keeps key creation available with an empty list', async () => {
    mocks.keys = [];
    await render();
    expect(container.querySelector('tbody')).toBeNull();
    await act(async () => button('Create API Key').click());
    expect(container.querySelector('#keyName')).not.toBeNull();
    await act(async () => button('Create').click());
    expect(mocks.create).toHaveBeenCalledWith({
      name: undefined,
      permissions: ['ingest'],
      expiresAt: expect.any(Number),
    });
    expect(container.textContent).toContain('API key created successfully');
  });
});
