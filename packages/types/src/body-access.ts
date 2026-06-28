export const BODY_ACCESS_TOKEN_AUDIENCE = 'trace-flow:api:bodies';
export const BODY_ACCESS_TOKEN_ISSUER = 'trace-flow:convex';
export const BODY_ACCESS_TOKEN_SCOPE = 'body:read';
export const BODY_ACCESS_TOKEN_TTL_SECONDS = 60;

export interface BodyAccessTokenClaims {
  sub: string;
  orgId: string;
  requestId: string;
  scope: typeof BODY_ACCESS_TOKEN_SCOPE;
}
