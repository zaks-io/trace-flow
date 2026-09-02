/**
 * MCP Server Card (SEP-2127, extension `io.modelcontextprotocol/server-card`).
 *
 * Static, pre-connection discovery metadata for the remote Trace Flow MCP server.
 * The card deliberately omits primitives (tools/resources/prompts) — those are
 * per-user and per-session, so clients must read them from `tools/list` at runtime.
 *
 * Schema source of truth:
 * https://github.com/modelcontextprotocol/experimental-ext-server-card/blob/main/schema.ts
 */
import { MCP_SERVER_CAPABILITIES, MCP_SERVER_INFO, SUPPORTED_PROTOCOL_VERSIONS } from './protocol';

export const SERVER_CARD_SCHEMA_URL =
  'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json';

export const SERVER_CARD_MEDIA_TYPE = 'application/mcp-server-card+json';

/** The card's reserved location, appended to the server's streamable-HTTP URL. */
const SERVER_CARD_SEGMENT = 'server-card';

/** Production streamable-HTTP endpoint, as published in `agents.md` and `/docs/mcp`. */
export const MCP_ENDPOINT_URL = 'https://mcp.trace-flow.dev/mcp';

/** Worker route path for the card: the endpoint's own path plus the reserved segment. */
export const SERVER_CARD_PATH = `${new URL(MCP_ENDPOINT_URL).pathname}/${SERVER_CARD_SEGMENT}`;

/** Where the card lives for a given streamable-HTTP endpoint. */
export function serverCardUrl(endpointUrl: string): string {
  return `${endpointUrl}/${SERVER_CARD_SEGMENT}`;
}

export const SITE_URL = 'https://trace-flow.dev';

/** Reverse-DNS server identity: exactly one slash separating namespace from name. */
const SERVER_CARD_NAME = 'trace-flow.dev/trace-flow';

/** The schema caps `description` at 100 characters. */
const SERVER_CARD_DESCRIPTION =
  'Query LLM and AI agent traces, spans, token usage, and cost analytics from Trace Flow.';

export interface ServerCardRemote {
  type: 'streamable-http' | 'sse';
  url: string;
  supportedProtocolVersions: string[];
}

export interface ServerCard {
  $schema: string;
  name: string;
  version: string;
  description: string;
  title: string;
  websiteUrl: string;
  repository: { url: string; source: string; subfolder: string };
  remotes: ServerCardRemote[];
  /**
   * Outside the SEP-2127 schema, which omits runtime-negotiated data. Discovery
   * crawlers read these flatter aliases of `serverInfo`/`remotes[0]` instead of
   * walking the array. They are advisory: clients still negotiate identity and
   * capabilities for real over `initialize`.
   */
  serverInfo: { name: string; version: string };
  transport: { type: ServerCardRemote['type']; endpoint: string };
  capabilities: typeof MCP_SERVER_CAPABILITIES;
}

/**
 * @param endpointUrl Absolute streamable-HTTP URL the card is advertising. The
 * card is served by the endpoint it describes, so callers pass their own origin
 * rather than assuming production.
 */
export function buildServerCard(endpointUrl: string): ServerCard {
  return {
    $schema: SERVER_CARD_SCHEMA_URL,
    name: SERVER_CARD_NAME,
    version: MCP_SERVER_INFO.version,
    description: SERVER_CARD_DESCRIPTION,
    title: 'Trace Flow',
    websiteUrl: SITE_URL,
    repository: {
      url: 'https://github.com/zaks-io/trace-flow',
      source: 'github',
      subfolder: 'apps/mcp',
    },
    remotes: [
      {
        type: 'streamable-http',
        url: endpointUrl,
        supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      },
    ],
    serverInfo: { ...MCP_SERVER_INFO },
    transport: { type: 'streamable-http', endpoint: endpointUrl },
    capabilities: MCP_SERVER_CAPABILITIES,
  };
}

/**
 * AI Catalog entry identifier, `urn:air:{publisher}:{namespace}:{name}`.
 * See https://github.com/Agent-Card/ai-catalog.
 */
export const AI_CATALOG_ENTRY_IDENTIFIER = 'urn:air:trace-flow.dev:mcp:trace-flow';

export const AI_CATALOG_MEDIA_TYPE = 'application/ai-catalog+json';

export interface AiCatalog {
  specVersion: string;
  host: { displayName: string; identifier: string; documentationUrl: string };
  entries: { identifier: string; type: string; url: string }[];
}

/**
 * The entry deliberately carries no `displayName` or `description`: the AI
 * Catalog spec makes the referenced Server Card the authoritative source for
 * both, so restating them here would only create values that can drift.
 */
export function buildAiCatalog(serverCardUrl: string): AiCatalog {
  return {
    specVersion: '1.0',
    host: {
      displayName: 'Trace Flow',
      identifier: 'trace-flow.dev',
      documentationUrl: `${SITE_URL}/docs`,
    },
    entries: [
      {
        identifier: AI_CATALOG_ENTRY_IDENTIFIER,
        type: SERVER_CARD_MEDIA_TYPE,
        url: serverCardUrl,
      },
    ],
  };
}
