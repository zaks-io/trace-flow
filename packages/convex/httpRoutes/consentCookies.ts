import { generateCookie } from 'hono/cookie';

// Each consent page sets a nonce cookie that the callback must see again, so an authorization only
// completes in the browser that approved it. MCP and Collector sign-ins use separate cookies so
// one cannot satisfy the other.
export const MCP_CONSENT_COOKIE = '__Host-trace-flow-mcp-consent';
export const COLLECTOR_CONSENT_COOKIE = '__Host-trace-flow-collector-consent';

export function serializeMcpConsentCookie(value: string, maxAge = 5 * 60): string {
  return serializeConsentCookie(MCP_CONSENT_COOKIE, value, maxAge);
}

export function serializeCollectorConsentCookie(value: string, maxAge = 5 * 60): string {
  return serializeConsentCookie(COLLECTOR_CONSENT_COOKIE, value, maxAge);
}

function serializeConsentCookie(name: string, value: string, maxAge: number): string {
  return generateCookie(name, value, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge,
  });
}
