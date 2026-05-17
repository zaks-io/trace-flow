import { fetchPipe, type PipeParam } from '@trace-flow/tinybird-client';
import { internal } from '../../_generated/api';
import type { ActionCtx } from '../../_generated/server';

export interface TinybirdScope {
  type: string;
  resource: string;
}

export interface TinybirdAccessCtx {
  runAction: ActionCtx['runAction'];
}

function tinybirdApiUrl(): string {
  return process.env.TINYBIRD_API_URL ?? 'https://api.us-west-2.aws.tinybird.co';
}

/**
 * Mint a per-org JWT via the internal action. ONE token-minting path —
 * never re-implement SignJWT inline.
 */
export async function generateMcpToken(
  ctx: TinybirdAccessCtx,
  scopes: TinybirdScope[],
  apiKeys: string[],
  retentionDays: number,
  ttlSeconds?: number,
): Promise<string> {
  return ctx.runAction(internal.integrations.tinybird.generateTokenInternal, {
    scopes,
    apiKeys,
    retentionDays,
    ttl: ttlSeconds,
  });
}

/**
 * Bearer-token fetch of a Tinybird Pipe with 403-retry semantics already
 * baked in by the shared client.
 */
export async function queryPipe(
  token: string,
  pipe: string,
  params?: Record<string, PipeParam>,
): Promise<Record<string, unknown>[]> {
  return fetchPipe<Record<string, unknown>>({
    baseUrl: tinybirdApiUrl(),
    token,
    pipe,
    params,
    retry: true,
  });
}
