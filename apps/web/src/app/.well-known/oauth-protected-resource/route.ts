import {
  buildProtectedResourceMetadata,
  MCP_AUTHORIZATION_SERVER_URL,
  MCP_ENDPOINT_URL,
} from '@trace-flow/mcp-core';

export function GET(): Response {
  return Response.json(
    buildProtectedResourceMetadata(MCP_ENDPOINT_URL, MCP_AUTHORIZATION_SERVER_URL),
    {
      headers: {
        'Cache-Control': 'public, max-age=300, s-maxage=300',
        'Access-Control-Allow-Origin': '*',
      },
    },
  );
}
