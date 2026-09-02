import { HOMEPAGE_DISCOVERY_LINK_HEADER } from './lib/api-catalog';

export function addHomepageDiscoveryLinks(request: Request, response: Response): Response {
  if (new URL(request.url).pathname !== '/') {
    return response;
  }

  const linkedResponse = new Response(response.body, response);
  linkedResponse.headers.append('Link', HOMEPAGE_DISCOVERY_LINK_HEADER);
  return linkedResponse;
}
