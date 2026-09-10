// @vitest-environment happy-dom

import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  persistQueryClientRestore,
  persistQueryClientSave,
} from '@tanstack/react-query-persist-client';
import { LogoutLink } from '@/components/LogoutLink';
import { QueryCacheProvider } from './QueryCacheProvider';
import { clearAuthenticatedCaches, createQueryCacheScope, type CacheStorage } from './query-cache';

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

class MemoryStorage implements CacheStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

function CacheConsumer({ freshValue, renders }: { freshValue: string; renders: string[] }) {
  const { data } = useQuery({
    queryKey: ['private'],
    queryFn: async () => freshValue,
    staleTime: Infinity,
  });
  const value = data ?? 'loading';
  renders.push(value);
  return <span>{value}</span>;
}

async function renderIdentity(root: Root, identity: string, freshValue: string, renders: string[]) {
  await act(async () => {
    root.render(
      <StrictMode>
        <QueryCacheProvider key={identity} identity={identity} fallback={<span>gated</span>}>
          <CacheConsumer freshValue={freshValue} renders={renders} />
        </QueryCacheProvider>
      </StrictMode>,
    );
    await Promise.resolve();
  });
  for (let attempt = 0; attempt < 10; attempt++) {
    await act(async () => {
      await Promise.resolve();
      await vi.runOnlyPendingTimersAsync();
    });
  }
}

async function save(scope: ReturnType<typeof createQueryCacheScope>) {
  await persistQueryClientSave({
    queryClient: scope.queryClient,
    persister: scope.persister,
    buster: process.env.NEXT_PUBLIC_DEPLOY_ID ?? 'dev',
  });
  await vi.advanceTimersByTimeAsync(1000);
}

describe('identity-scoped query cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    vi.useRealTimers();
  });

  it('restores a reload for the same user and organization', async () => {
    const storage = new MemoryStorage();
    const first = createQueryCacheScope(storage, JSON.stringify(['user-a', 'org-a']));
    first.activate();
    first.queryClient.setQueryData(['private'], 'org-a-data');
    await save(first);

    const reload = createQueryCacheScope(storage, JSON.stringify(['user-a', 'org-a']));
    await persistQueryClientRestore({
      queryClient: reload.queryClient,
      persister: reload.persister,
      buster: process.env.NEXT_PUBLIC_DEPLOY_ID ?? 'dev',
    });

    expect(reload.queryClient.getQueryData(['private'])).toBe('org-a-data');
  });

  it('removes the prior namespace when the user or organization changes', async () => {
    const storage = new MemoryStorage();
    storage.setItem('REACT_QUERY_OFFLINE_CACHE', 'legacy-private-data');
    const userA = createQueryCacheScope(storage, JSON.stringify(['user-a', 'org-a']));
    userA.activate();
    userA.queryClient.setQueryData(['private'], 'user-a-data');
    await save(userA);
    expect(storage.getItem('REACT_QUERY_OFFLINE_CACHE')).toBeNull();

    const userB = createQueryCacheScope(storage, JSON.stringify(['user-b', 'org-a']));
    userB.activate();
    expect(storage.getItem(userA.storageKey)).toBeNull();
    expect(userA.queryClient.getQueryData(['private'])).toBeUndefined();

    userB.queryClient.setQueryData(['private'], 'user-b-data');
    await save(userB);
    const otherOrg = createQueryCacheScope(storage, JSON.stringify(['user-b', 'org-b']));
    otherOrg.activate();
    expect(storage.getItem(userB.storageKey)).toBeNull();
    expect(userB.queryClient.getQueryData(['private'])).toBeUndefined();
  });

  it('clears logout state and blocks a throttled write from recreating it', async () => {
    const storage = new MemoryStorage();
    const scope = createQueryCacheScope(storage, JSON.stringify(['user-a', 'org-a']));
    scope.activate();
    scope.queryClient.setQueryData(['private'], 'private-data');
    void persistQueryClientSave({
      queryClient: scope.queryClient,
      persister: scope.persister,
      buster: process.env.NEXT_PUBLIC_DEPLOY_ID ?? 'dev',
    });

    clearAuthenticatedCaches(storage);
    await vi.advanceTimersByTimeAsync(1000);

    expect(storage.getItem(scope.storageKey)).toBeNull();
    expect(scope.queryClient.getQueryData(['private'])).toBeUndefined();
  });

  it('clears the authenticated cache before following a logout link', async () => {
    sessionStorage.clear();
    const scope = createQueryCacheScope(sessionStorage, JSON.stringify(['user-a', 'org-a']));
    scope.activate();
    scope.queryClient.setQueryData(['private'], 'private-data');
    await save(scope);

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<LogoutLink onClick={(event) => event.preventDefault()}>Sign out</LogoutLink>);
    });
    await act(async () => {
      container.querySelector('a')?.click();
    });

    expect(sessionStorage.getItem(scope.storageKey)).toBeNull();
    expect(scope.queryClient.getQueryData(['private'])).toBeUndefined();

    await act(async () => root.unmount());
    container.remove();
  });

  it('mounts under Strict Mode, restores the same identity, and gates identity transitions', async () => {
    sessionStorage.clear();
    const identityA = JSON.stringify(['user-a', 'org-a']);
    const identityB = JSON.stringify(['user-b', 'org-a']);
    const identityBOrgB = JSON.stringify(['user-b', 'org-b']);
    const seeded = createQueryCacheScope(sessionStorage, identityA);
    seeded.activate();
    seeded.queryClient.setQueryData(['private'], 'persisted-a');
    await save(seeded);
    seeded.dispose();

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const renders: string[] = [];

    await renderIdentity(root, identityA, 'fresh-a', renders);
    expect(container.textContent).toBe('persisted-a');

    const userSwitchStart = renders.length;
    await renderIdentity(root, identityB, 'fresh-b', renders);
    expect(container.textContent).toBe('fresh-b');
    expect(renders.slice(userSwitchStart)).not.toContain('persisted-a');

    const orgSwitchStart = renders.length;
    await renderIdentity(root, identityBOrgB, 'fresh-b-org-b', renders);
    expect(container.textContent).toBe('fresh-b-org-b');
    expect(renders.slice(orgSwitchStart)).not.toContain('fresh-b');

    await act(async () => root.unmount());
    container.remove();
  });
});
