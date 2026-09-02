import { describe, it, expect } from 'vitest';
import { MCP_SERVER_INFO, SUPPORTED_PROTOCOL_VERSIONS } from '../protocol';
import {
  AI_CATALOG_ENTRY_IDENTIFIER,
  MCP_ENDPOINT_URL,
  SERVER_CARD_MEDIA_TYPE,
  SERVER_CARD_PATH,
  SERVER_CARD_SCHEMA_URL,
  buildAiCatalog,
  buildServerCard,
  serverCardUrl,
} from '../server-card';

// Constraints copied from the extension's schema.ts. A card that violates one of
// these is rejected by conformant clients, and nothing else in the build catches it.
// https://github.com/modelcontextprotocol/experimental-ext-server-card/blob/main/schema.ts
const NAME_PATTERN = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;
const DESCRIPTION_MAX_LENGTH = 100;
const REMOTE_URL_PATTERN = /^(https?:\/\/[^\s]+|\{[a-zA-Z_][a-zA-Z0-9_]*\}[^\s]*)$/;

describe('buildServerCard', () => {
  const card = buildServerCard(MCP_ENDPOINT_URL);

  it('declares the v1 server card schema URL', () => {
    expect(card.$schema).toBe(
      'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
    );
    expect(SERVER_CARD_SCHEMA_URL).toBe(card.$schema);
  });

  it('uses a reverse-DNS name with exactly one slash', () => {
    expect(card.name).toMatch(NAME_PATTERN);
    expect(card.name.split('/')).toHaveLength(2);
    expect(card.name.length).toBeGreaterThanOrEqual(3);
    expect(card.name.length).toBeLessThanOrEqual(200);
  });

  it('keeps the description within the schema length cap', () => {
    expect(card.description.length).toBeGreaterThan(0);
    expect(card.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX_LENGTH);
  });

  it('advertises the endpoint it was built for as streamable HTTP', () => {
    expect(card.remotes).toHaveLength(1);
    const [remote] = card.remotes;
    expect(remote).toEqual({
      type: 'streamable-http',
      url: MCP_ENDPOINT_URL,
      supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    });
    expect(remote?.url).toMatch(REMOTE_URL_PATTERN);
  });

  it('advertises the caller origin rather than a baked-in production URL', () => {
    const previewUrl = 'https://trace-flow-mcp-preview.workers.dev/mcp';
    const previewCard = buildServerCard(previewUrl);
    expect(previewCard.remotes[0]?.url).toBe(previewUrl);
    expect(previewCard.transport.endpoint).toBe(previewUrl);
  });

  it('reports the same identity the server returns from initialize', () => {
    expect(card.serverInfo).toEqual({ ...MCP_SERVER_INFO });
    expect(card.version).toBe(MCP_SERVER_INFO.version);
  });

  // The flat aliases exist for crawlers; if they drift from `remotes[0]` the card
  // starts telling two different stories about where the server lives.
  it('keeps the flat transport alias in step with remotes', () => {
    expect(card.transport).toEqual({ type: 'streamable-http', endpoint: MCP_ENDPOINT_URL });
    expect(card.transport.endpoint).toBe(card.remotes[0]?.url);
    expect(card.transport.type).toBe(card.remotes[0]?.type);
  });

  // SEP-2127 deliberately excludes primitives: a static list cannot represent a
  // per-user, per-session tool surface. Clients must read `tools/list` instead.
  it('does not enumerate primitives', () => {
    expect(card).not.toHaveProperty('tools');
    expect(card).not.toHaveProperty('resources');
    expect(card).not.toHaveProperty('prompts');
  });
});

describe('serverCardUrl', () => {
  // The spec reserves `<streamable-http-url>/server-card`, so the segment appends
  // to the endpoint's whole URL. Resolving it as a path would silently drop any
  // endpoint path deeper than `/mcp`.
  it('appends the reserved segment to the endpoint it is given', () => {
    expect(serverCardUrl(MCP_ENDPOINT_URL)).toBe('https://mcp.trace-flow.dev/mcp/server-card');
    expect(serverCardUrl('https://example.test/v2/mcp')).toBe(
      'https://example.test/v2/mcp/server-card',
    );
  });

  it('routes the worker at the path half of that URL', () => {
    expect(SERVER_CARD_PATH).toBe(new URL(serverCardUrl(MCP_ENDPOINT_URL)).pathname);
  });
});

describe('buildAiCatalog', () => {
  const cardUrl = serverCardUrl(MCP_ENDPOINT_URL);
  const catalog = buildAiCatalog(cardUrl);

  it('points a typed entry at the reserved server card location', () => {
    expect(catalog.entries).toEqual([
      {
        identifier: AI_CATALOG_ENTRY_IDENTIFIER,
        type: 'application/mcp-server-card+json',
        url: cardUrl,
      },
    ]);
    expect(SERVER_CARD_MEDIA_TYPE).toBe('application/mcp-server-card+json');
  });

  it('names the catalog operator', () => {
    expect(catalog.host.displayName).toBe('Trace Flow');
    expect(catalog.host.identifier).toBe('trace-flow.dev');
  });

  // The spec makes the Server Card authoritative for both, so restating them on
  // the entry only creates a second copy that can drift.
  it('leaves display name and description to the server card', () => {
    expect(catalog.entries[0]).not.toHaveProperty('displayName');
    expect(catalog.entries[0]).not.toHaveProperty('description');
  });

  it('uses a domain-anchored urn:air identifier', () => {
    expect(AI_CATALOG_ENTRY_IDENTIFIER).toMatch(/^urn:air:[^:]+:[^:]+:[^:]+$/);
  });
});
