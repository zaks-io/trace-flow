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

  export function createExecutionContext(): ExecutionContext;
  export function waitOnExecutionContext(ctx: ExecutionContext): Promise<void>;
}
