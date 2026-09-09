import { generateCookie } from 'hono/cookie';

export const MCP_CONSENT_COOKIE = '__Host-trace-flow-mcp-consent';

export function serializeMcpConsentCookie(value: string, maxAge = 5 * 60): string {
  return generateCookie(MCP_CONSENT_COOKIE, value, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge,
  });
}
