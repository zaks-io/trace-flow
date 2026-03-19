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
    };
  }[];
  exp?: number;
}

export interface CacheParams {
  apiKeys: string;
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

export function extractCacheParams(payload: TinybirdJWTPayload): CacheParams {
  const scope = payload.scopes?.[0];
  if (!scope) {
    throw new Error('JWT missing scopes');
  }

  return {
    apiKeys: scope.fixed_params?.api_keys ?? '',
    retentionDays: scope.fixed_params?.retention_days ?? 0,
  };
}
