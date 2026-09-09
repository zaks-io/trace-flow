import type { Context, Next } from 'hono';
import { axiomConfigFromEnv, createLogger } from '@trace-flow/logging';
import { assertBodyEncryptionRootKey } from '@trace-flow/utils';
import type { ProxyEnv } from './context';

// null, not undefined: an unbound secret reads as undefined and must never match the cache.
let verifiedRootKey: string | null = null;

/**
 * Validates deploy-time configuration that would otherwise only fail inside the
 * durability gate, after the upstream status has already been sent. Workers have
 * no boot hook with bindings, so the check runs on the first request per isolate
 * and is memoized on the secret's value.
 */
export function assertStartupConfig(env: Pick<ProxyEnv, 'BODY_ENCRYPTION_ROOT_KEY'>): void {
  if (verifiedRootKey !== null && env.BODY_ENCRYPTION_ROOT_KEY === verifiedRootKey) return;
  assertBodyEncryptionRootKey(env.BODY_ENCRYPTION_ROOT_KEY);
  verifiedRootKey = env.BODY_ENCRYPTION_ROOT_KEY;
}

/**
 * Refuses every request, including `/healthz`, while the gateway is misconfigured
 * so a bad secret shows up as a red health check instead of dead response bodies.
 */
export async function startupConfigGuard(
  c: Context<{ Bindings: ProxyEnv }>,
  next: Next,
): Promise<Response | void> {
  try {
    assertStartupConfig(c.env);
  } catch (err) {
    const logger = createLogger({
      service: 'proxy',
      runtime: 'cloudflare-worker',
      axiom: axiomConfigFromEnv(c.env),
      context: { component: 'startup' },
    });
    logger.error('proxy.startup_config_invalid', err);
    c.executionCtx.waitUntil(logger.flush());
    return c.json(
      {
        error: 'Gateway misconfigured',
        message: err instanceof Error ? err.message : String(err),
      },
      503,
    );
  }
  await next();
}
