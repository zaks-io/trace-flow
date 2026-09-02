import {
  AI_CATALOG_MEDIA_TYPE,
  MCP_ENDPOINT_URL,
  buildAiCatalog,
  serverCardUrl,
} from '@trace-flow/mcp-core';

// Domain-level discovery entry point (SEP-2127). Points at the card served by
// the MCP server itself, which is the location the spec reserves. Deployments of
// this app other than production still name the canonical production endpoint:
// a catalog is a directory of the real service, not of whoever served it.
export function GET() {
  return new Response(JSON.stringify(buildAiCatalog(serverCardUrl(MCP_ENDPOINT_URL)), null, 2), {
    headers: {
      'Content-Type': AI_CATALOG_MEDIA_TYPE,
      // Matches the other public discovery documents. Deploys have no purge
      // step, so the TTL is the whole invalidation story.
      'Cache-Control': 'public, max-age=300, s-maxage=300',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
