/* eslint-disable @typescript-eslint/no-explicit-any */
declare module 'cloudflare:test' {
  export const env: any;
  export const SELF: any;
  export function runInDurableObject<T>(
    stub: DurableObjectStub,
    callback: (instance: T, state: DurableObjectState) => any,
  ): Promise<any>;
  export function runDurableObjectAlarm(stub: DurableObjectStub): Promise<boolean>;
}
