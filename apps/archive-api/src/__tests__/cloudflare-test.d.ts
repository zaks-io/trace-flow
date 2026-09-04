declare module 'cloudflare:test' {
  import type { ExecutionContext } from '@cloudflare/workers-types';

  export const env: Record<string, unknown>;
  export function createExecutionContext(): ExecutionContext;
  export function waitOnExecutionContext(ctx: ExecutionContext): Promise<void>;
}
