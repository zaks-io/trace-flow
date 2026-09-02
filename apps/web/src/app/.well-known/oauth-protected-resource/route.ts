import { MCP_PROTECTED_RESOURCE_METADATA_URL } from '@trace-flow/mcp-core';

export function GET(): Response {
  return new Response(null, {
    status: 307,
    headers: {
      Location: MCP_PROTECTED_RESOURCE_METADATA_URL,
      'Cache-Control': 'public, max-age=300, s-maxage=300',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
