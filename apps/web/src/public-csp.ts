import { CSP_HEADER_NAME } from './lib/csp';

// Keep DOM Request/Response types consistent with Next while using Worker handlers.
declare const HTMLRewriter: {
  new (): {
    on(
      selector: string,
      handlers: import('@cloudflare/workers-types').HTMLRewriterElementContentHandlers,
    ): { transform(response: Response): Response };
  };
};

interface PageScripts {
  hashes: string[];
  external: Record<string, string>;
}

export function protectStaticPage(
  request: Request,
  response: Response,
  pages: Record<string, PageScripts>,
): Response {
  if (response.headers.get('content-type')?.split(';')[0] !== 'text/html') return response;

  let pathname = new URL(request.url).pathname;
  try {
    pathname = decodeURI(pathname);
  } catch {
    // Malformed URLs have no corresponding prerendered route.
  }
  const csp = response.headers.get(CSP_HEADER_NAME);
  const scripts =
    pages[pathname] ?? (response.status === 404 && csp ? pages['/_not-found'] : undefined);
  if (!scripts) return response;

  if (!csp) throw new Error(`Missing CSP for static HTML route: ${pathname}`);
  const scriptPolicy = csp.match(/(?:^|;\s*)script-src ([^;]+)/)?.[1];
  const nonce = scriptPolicy?.match(/'nonce-([^']+)'/)?.[1];
  if (!nonce || !scriptPolicy?.includes("'strict-dynamic'")) {
    throw new Error(`Missing strict nonce policy for static HTML route: ${pathname}`);
  }

  const headers = new Headers(response.headers);
  const hashes = scripts.hashes.map((hash) => `'${hash}'`).join(' ');
  headers.set(CSP_HEADER_NAME, csp.replace(/script-src ([^;]+)/, `script-src $1 ${hashes}`));
  // A fresh nonce policy must never be replayed from a browser or CDN cache.
  headers.set('cache-control', 'private, no-store');
  for (const name of ['content-length', 'etag', 'last-modified']) headers.delete(name);

  return new HTMLRewriter()
    .on('script[src], link[as="script"]', {
      element(element) {
        const src = element.getAttribute('src') ?? element.getAttribute('href');
        const integrity = src && scripts.external[src];
        if (integrity) {
          element.setAttribute('nonce', nonce);
          element.setAttribute('integrity', integrity);
          element.setAttribute('crossorigin', 'anonymous');
        }
      },
    })
    .transform(new Response(response.body, { status: response.status, headers }));
}
