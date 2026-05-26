declare module 'cloudflare:test' {
  import type { ExecutionContext } from '@cloudflare/workers-types';

  export interface MockReplyOptions {
    path: string;
    method?: string;
  }

  export interface FetchMock {
    activate(): void;
    deactivate(): void;
    disableNetConnect(): void;
    enableNetConnect(): void;
    get(origin: string): {
      intercept(options: MockReplyOptions): {
        reply(
          status: number,
          body:
            | string
            | ((opts: { path: string; method: string; headers: unknown; body?: string }) => string),
          options?: { headers?: Record<string, string> },
        ): { persist(): void; times(n: number): void };
      };
    };
  }

  export const fetchMock: FetchMock;

  export function createExecutionContext(): ExecutionContext;
  export function waitOnExecutionContext(ctx: ExecutionContext): Promise<void>;
}
