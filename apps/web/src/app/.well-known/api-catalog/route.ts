import { API_CATALOG_CONTENT_TYPE, API_CATALOG_PATH, buildApiCatalog } from '@/lib/api-catalog';

/**
 * RFC 9727 §2 requires a HEAD on this URI to answer with the api-catalog link
 * relation. Next derives HEAD from GET, so the Link header is set on both.
 */
export async function GET(request: Request) {
  const envSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  const siteUrl = envSiteUrl ?? new URL(request.url).origin;

  return new Response(JSON.stringify(buildApiCatalog(siteUrl), null, 2), {
    headers: {
      'Content-Type': API_CATALOG_CONTENT_TYPE,
      Link: `<${siteUrl}${API_CATALOG_PATH}>; rel="api-catalog"`,
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  });
}
