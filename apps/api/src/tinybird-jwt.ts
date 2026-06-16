import { jwtVerify } from 'jose';

export interface TinybirdJWTPayload {
  workspace_id: string;
  name: string;
  scopes: {
    type: string;
    resource: string;
    fixed_params?: {
      api_keys?: string;
      retention_days?: number;
      org_id?: string;
    };
  }[];
  exp?: number;
}

interface CacheParams {
  apiKeys: string;
  orgId: string;
  retentionDays: number;
}

export async function verifyTinybirdJWT(
  token: string,
  adminToken: string,
): Promise<TinybirdJWTPayload> {
  const secret = new TextEncoder().encode(adminToken);
  const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
  return payload as unknown as TinybirdJWTPayload;
}

function cacheParamsFromScope(scope: TinybirdJWTPayload['scopes'][number]): CacheParams {
  return {
    apiKeys: scope.fixed_params?.api_keys ?? '',
    orgId: scope.fixed_params?.org_id ?? '',
    retentionDays: scope.fixed_params?.retention_days ?? 0,
  };
}

function haveSameCacheParams(left: CacheParams, right: CacheParams): boolean {
  return (
    left.apiKeys === right.apiKeys &&
    left.orgId === right.orgId &&
    left.retentionDays === right.retentionDays
  );
}

export function extractCacheParams(payload: TinybirdJWTPayload, pipe: string): CacheParams {
  const pipeReadScopes = payload.scopes?.filter((scope) => scope.type === 'PIPES:READ') ?? [];
  if (pipeReadScopes.length === 0) {
    throw new Error('JWT missing PIPES:READ scopes');
  }

  const cacheParams = cacheParamsFromScope(pipeReadScopes[0]);
  for (const scope of pipeReadScopes.slice(1)) {
    if (!haveSameCacheParams(cacheParams, cacheParamsFromScope(scope))) {
      throw new Error('JWT PIPES:READ scopes have inconsistent fixed_params');
    }
  }

  if (!pipeReadScopes.some((scope) => scope.resource === pipe)) {
    throw new Error('JWT missing PIPES:READ scope for requested pipe');
  }

  return cacheParams;
}
