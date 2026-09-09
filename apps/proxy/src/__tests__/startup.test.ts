import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { ProxyEnv } from '../context';
import { app } from '../index';
import { assertStartupConfig } from '../startup';

const VALID_ROOT_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
// 64 hex chars: 32 bytes of entropy, but base64-decodes to 48 bytes.
const HEX_ROOT_KEY = '0'.repeat(64);

const executionCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

describe('startup configuration', () => {
  it('accepts a 32-byte root key', () => {
    expect(() => assertStartupConfig({ BODY_ENCRYPTION_ROOT_KEY: VALID_ROOT_KEY })).not.toThrow();
  });

  it('rejects a root key that does not decode to 32 bytes', () => {
    expect(() => assertStartupConfig({ BODY_ENCRYPTION_ROOT_KEY: HEX_ROOT_KEY })).toThrow(
      'Body encryption root key must decode to 32 bytes',
    );
  });

  it('rejects an unbound root key even before any key was verified', () => {
    const unbound = {} as Pick<ProxyEnv, 'BODY_ENCRYPTION_ROOT_KEY'>;
    expect(() => assertStartupConfig(unbound)).toThrow('Body encryption root key is required');
  });

  it('fails /healthz with 503 when the root key is unbound', async () => {
    const { BODY_ENCRYPTION_ROOT_KEY: _unbound, ...unboundEnv } = env;
    const res = await app.request('http://localhost/healthz', {}, unboundEnv, executionCtx);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'Gateway misconfigured',
      message: 'Body encryption root key is required',
    });
  });

  it('serves /healthz when the root key is valid', async () => {
    const res = await app.request('http://localhost/healthz', {}, env, executionCtx);
    expect(res.status).toBe(200);
  });

  it('fails /healthz and proxy routes with 503 when the root key is malformed', async () => {
    const badEnv = { ...env, BODY_ENCRYPTION_ROOT_KEY: HEX_ROOT_KEY };

    const health = await app.request('http://localhost/healthz', {}, badEnv, executionCtx);
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({
      error: 'Gateway misconfigured',
      message: 'Body encryption root key must decode to 32 bytes',
    });

    const proxied = await app.request(
      'http://localhost/anthropic/v1/messages',
      { method: 'POST', headers: { 'X-Trace-Flow-Api-Key': 'tf_test' } },
      badEnv,
      executionCtx,
    );
    expect(proxied.status).toBe(503);
  });
});
