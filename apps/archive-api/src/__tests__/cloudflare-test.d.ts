declare module 'cloudflare:test' {
  import type { ExecutionContext } from '@cloudflare/workers-types';

  export const env: Record<string, unknown>;
  export function createExecutionContext(): ExecutionContext;
  export function waitOnExecutionContext(ctx: ExecutionContext): Promise<void>;
  export function runInDurableObject<T, R>(
    stub: DurableObjectStub,
    callback: (instance: T, state: DurableObjectState) => R,
  ): Promise<R>;
}

declare module '*.jsonl?raw' {
  const content: string;
  export default content;
}

declare module '*.json?raw' {
  const content: string;
  export default content;
}
