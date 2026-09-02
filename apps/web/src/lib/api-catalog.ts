/**
 * API catalog document (RFC 9727) served from /.well-known/api-catalog.
 *
 * Anchors are absolute production hosts rather than the request origin: the
 * catalog describes the Publisher's public APIs, which live on dedicated
 * `*.trace-flow.dev` Workers regardless of which deploy serves this document.
 */

export const API_CATALOG_PATH = '/.well-known/api-catalog';
export const API_CATALOG_CONTENT_TYPE =
  'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"';

const GATEWAY_URL = 'https://gateway.trace-flow.dev';
const MCP_URL = 'https://mcp.trace-flow.dev';

type LinkTarget = {
  href: string;
  type: string;
  title: string;
};

type CatalogEntry = {
  anchor: string;
  'service-desc'?: LinkTarget[];
  'service-doc'?: LinkTarget[];
  status?: LinkTarget[];
};

export type ApiCatalog = {
  linkset: CatalogEntry[];
};

/**
 * `siteUrl` anchors the human documentation links, which are served by this
 * app, so a preview deploy documents itself instead of pointing at production.
 */
export function buildApiCatalog(siteUrl: string): ApiCatalog {
  const docs = siteUrl.replace(/\/$/, '');

  return {
    linkset: [
      {
        anchor: GATEWAY_URL,
        'service-desc': [
          {
            href: `${GATEWAY_URL}/openapi.json`,
            type: 'application/json',
            title: 'Trace Flow gateway OpenAPI 3.0 description',
          },
        ],
        'service-doc': [
          {
            href: `${docs}/docs/sdk-reference`,
            type: 'text/html',
            title: 'Gateway SDK reference: provider routes, headers, and examples',
          },
        ],
        status: [
          {
            href: `${GATEWAY_URL}/healthz`,
            type: 'application/json',
            title: 'Gateway health',
          },
        ],
      },
      {
        anchor: `${MCP_URL}/mcp`,
        'service-doc': [
          {
            href: `${docs}/docs/mcp`,
            type: 'text/html',
            title: 'MCP server: endpoint, client configuration, and available tools',
          },
        ],
        status: [
          {
            href: `${MCP_URL}/healthz`,
            type: 'application/json',
            title: 'MCP server health',
          },
        ],
      },
    ],
  };
}
