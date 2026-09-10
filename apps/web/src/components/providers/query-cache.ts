import { QueryClient } from '@tanstack/react-query';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import { clearBodyAccessTokenCache } from '@/lib/bodies';
import { clearTokenCache } from '@/lib/tinybird';

const LEGACY_QUERY_CACHE_KEY = 'REACT_QUERY_OFFLINE_CACHE';
const ACTIVE_QUERY_CACHE_KEY = 'trace-flow:active-query-cache';
const QUERY_CACHE_KEY_PREFIX = 'trace-flow:query-cache:';

export type CacheStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface QueryCacheScope {
  queryClient: QueryClient;
  persister: ReturnType<typeof createSyncStoragePersister>;
  storageKey: string;
  activate: () => void;
  dispose: () => void;
}

let activeQueryCacheScope: QueryCacheScope | null = null;

function clearTokenCaches() {
  clearBodyAccessTokenCache();
  clearTokenCache();
}

export function createQueryCacheScope(storage: CacheStorage, identity: string): QueryCacheScope {
  const storageKey = `${QUERY_CACHE_KEY_PREFIX}${encodeURIComponent(identity)}`;
  let active = false;
  const scopedStorage: CacheStorage = {
    getItem: (key) => storage.getItem(key),
    setItem: (key, value) => {
      if (active) storage.setItem(key, value);
    },
    removeItem: (key) => storage.removeItem(key),
  };
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30 * 1000,
        gcTime: 15 * 60 * 1000,
        refetchOnWindowFocus: false,
      },
    },
  });
  const persister = createSyncStoragePersister({
    storage: scopedStorage,
    key: storageKey,
    throttleTime: 1000,
  });

  const scope: QueryCacheScope = {
    queryClient,
    persister,
    storageKey,
    activate() {
      if (activeQueryCacheScope && activeQueryCacheScope !== scope) {
        activeQueryCacheScope.dispose();
      }
      const previousStorageKey = storage.getItem(ACTIVE_QUERY_CACHE_KEY);
      if (previousStorageKey && previousStorageKey !== storageKey) {
        storage.removeItem(previousStorageKey);
      }
      storage.removeItem(LEGACY_QUERY_CACHE_KEY);
      storage.setItem(ACTIVE_QUERY_CACHE_KEY, storageKey);
      clearTokenCaches();
      active = true;
      activeQueryCacheScope = scope;
    },
    dispose() {
      active = false;
      void queryClient.cancelQueries();
      queryClient.clear();
      if (activeQueryCacheScope === scope) activeQueryCacheScope = null;
      clearTokenCaches();
    },
  };

  return scope;
}

export function clearAuthenticatedCaches(storage: CacheStorage = window.sessionStorage) {
  activeQueryCacheScope?.dispose();
  const activeStorageKey = storage.getItem(ACTIVE_QUERY_CACHE_KEY);
  if (activeStorageKey) storage.removeItem(activeStorageKey);
  storage.removeItem(ACTIVE_QUERY_CACHE_KEY);
  storage.removeItem(LEGACY_QUERY_CACHE_KEY);
  clearTokenCaches();
}
