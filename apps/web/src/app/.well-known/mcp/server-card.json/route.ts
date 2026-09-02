import { MCP_ENDPOINT_URL, SERVER_CARD_MEDIA_TYPE, buildServerCard } from '@trace-flow/mcp-core';

// Site-wide discovery copy of the card the MCP server publishes at
// `<streamable-http-url>/server-card`. Both are built from the same source so
// the two documents cannot drift. This copy always names the canonical
// production endpoint, including from preview and dev deployments of this app.
export function GET() {
  return new Response(JSON.stringify(buildServerCard(MCP_ENDPOINT_URL), null, 2), {
    headers: {
      'Content-Type': SERVER_CARD_MEDIA_TYPE,
      // Matches the other public discovery documents. Deploys have no purge
      // step, so the TTL is the whole invalidation story.
      'Cache-Control': 'public, max-age=300, s-maxage=300',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
