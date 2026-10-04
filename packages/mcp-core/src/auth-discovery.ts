import { MCP_ENDPOINT_URL } from './server-card';

export const AUTH_MD_PATH = '/auth.md';
export const PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

export const MCP_AUTHORIZATION_SERVER_URL = 'https://connect.trace-flow.dev';
export const MCP_PROTECTED_RESOURCE_METADATA_URL = new URL(
  PROTECTED_RESOURCE_METADATA_PATH,
  MCP_ENDPOINT_URL,
).toString();

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: ['header'];
  resource_name: string;
}

export function buildProtectedResourceMetadata(
  resource: string,
  authorizationServer: string,
): ProtectedResourceMetadata {
  return {
    resource,
    authorization_servers: [authorizationServer.replace(/\/+$/, '')],
    bearer_methods_supported: ['header'],
    resource_name: 'Trace Flow MCP',
  };
}

export const AUTH_MD = `# Trace Flow auth.md

This document is for AI agents and API clients connecting to the Trace Flow MCP service. Trace Flow supports permissioned API keys for headless clients, and OAuth 2.0 dynamic client registration followed by Authorization Code with PKCE for interactive clients. Registration starts without an identity assertion; a user signs in and approves access before Trace Flow issues a credential.

## Discover

1. Fetch \`${MCP_PROTECTED_RESOURCE_METADATA_URL}\`.
2. Read \`authorization_servers\` from that document.
3. Fetch \`${MCP_AUTHORIZATION_SERVER_URL}/.well-known/oauth-authorization-server\`, the metadata URL for the advertised authorization server.
4. Use the endpoints and methods in that metadata. Do not probe registration with a test POST during passive discovery.

Protected resource: \`${MCP_ENDPOINT_URL}\`

## API keys for sandboxes

Create a key on https://trace-flow.dev/app/api-keys with MCP read access enabled.
New keys default to Send traces only; existing keys remain ingest-only. MCP read
access reads the owner's organization traces, usage and coding-agent analytics.
Access is fixed at creation. MCP currently has no write tools or write permission.

Provide the key through the sandbox's TRACE_FLOW_API_KEY secret environment variable.
Send Authorization: Bearer <api_key> on every MCP request. Codex supports
bearer_token_env_var = "TRACE_FLOW_API_KEY"; Claude Code supports environment-variable
expansion in the Authorization header of .mcp.json. Never write raw keys into
checked-in configuration or command-line arguments. Detailed setup examples:
https://trace-flow.dev/docs/mcp#api-keys-for-sandboxes

Ingest-only keys receive HTTP 403 with an insufficient_scope challenge requiring
mcp:read. Invalid or expired keys receive HTTP 401. Deleted keys, disabled accounts
and inactive organization memberships fail on the next request. OAuth remains available.

## Register an OAuth client

Send \`POST ${MCP_AUTHORIZATION_SERVER_URL}/mcp/register\` with JSON:

\`\`\`json
{
  "redirect_uris": ["https://agent.example/callback"],
  "client_name": "Example Agent"
}
\`\`\`

Loopback \`http\` redirect URIs are supported for native clients. Other redirect URIs must use \`https\`. Store the returned \`client_id\`; this public-client registration does not issue a secret.

## Ask the user to authorize

Generate a PKCE verifier and its S256 challenge. Open the authorization endpoint from metadata with \`response_type=code\`, the registered \`client_id\` and \`redirect_uri\`, a fresh \`state\`, \`code_challenge\`, \`code_challenge_method=S256\`, and \`resource=${MCP_ENDPOINT_URL}\`.

The user signs in and approves access. Verify \`state\` when the authorization server redirects to the registered callback with a code.

## Exchange and use the credential

Send the code to the metadata's token endpoint as \`application/x-www-form-urlencoded\` with \`grant_type=authorization_code\`, \`code\`, \`client_id\`, \`redirect_uri\`, \`code_verifier\`, and \`resource=${MCP_ENDPOINT_URL}\`.

Use the returned access token on requests to \`${MCP_ENDPOINT_URL}\`:

\`\`\`http
Authorization: Bearer <access_token>
\`\`\`

Access tokens are scoped to the authorizing user's Trace Flow organization. Keep access and refresh tokens out of logs and source control. When an access token expires, use the token endpoint's \`refresh_token\` grant with \`refresh_token\`, \`client_id\`, and the same \`resource\`. If refresh fails or the service returns \`invalid_token\`, discard the credentials and restart discovery and authorization.
`;
