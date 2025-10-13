declare module 'cloudflare:test' {
  import type { ExecutionContext, KVNamespace, R2Bucket } from '@cloudflare/workers-types';

  export const env: {
    API_KEYS: KVNamespace;
    STORAGE: R2Bucket;
    [key: string]: unknown;
  };

  export const SELF: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };

  export interface FetchMock {
    activate(): void;
    disableNetConnect(): void;
    get(origin: string): {
      intercept(options: { path: string; method?: string }): {
        reply(
          status: number,
          body: string | ((opts: { headers?: Record<string, string> }) => string),
          options?: { headers?: Record<string, string> },
        ): void;
      };
    };
  }

  export const fetchMock: FetchMock;

  export function createExecutionContext(): ExecutionContext;
  export function waitOnExecutionContext(ctx: ExecutionContext): Promise<void>;
}
