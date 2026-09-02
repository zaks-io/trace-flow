import { AUTH_MD } from '@trace-flow/mcp-core';

export function GET(): Response {
  return new Response(AUTH_MD, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  });
}
