import { describe, expect, it } from 'vitest';
import {
  AUTH_MD,
  buildProtectedResourceMetadata,
  MCP_AUTHORIZATION_SERVER_URL,
  MCP_PROTECTED_RESOURCE_METADATA_URL,
} from '../auth-discovery';
import { MCP_ENDPOINT_URL } from '../server-card';

describe('Auth.md discovery', () => {
  it('publishes complete protected-resource metadata', () => {
    expect(buildProtectedResourceMetadata(MCP_ENDPOINT_URL, MCP_AUTHORIZATION_SERVER_URL)).toEqual({
      resource: 'https://mcp.trace-flow.dev/mcp',
      authorization_servers: ['https://connect.trace-flow.dev'],
      bearer_methods_supported: ['header'],
      resource_name: 'Trace Flow MCP',
    });
  });

  it('gives agents a complete registration and credential-use procedure', () => {
    expect(AUTH_MD).toMatch(/^# .*auth\.md/im);
    expect(MCP_PROTECTED_RESOURCE_METADATA_URL).toBe(
      'https://mcp.trace-flow.dev/.well-known/oauth-protected-resource',
    );
    expect(AUTH_MD).toContain(MCP_PROTECTED_RESOURCE_METADATA_URL);
    expect(AUTH_MD).toContain(
      'https://connect.trace-flow.dev/.well-known/oauth-authorization-server',
    );
    expect(AUTH_MD).toContain('POST https://connect.trace-flow.dev/mcp/register');
    expect(AUTH_MD).toContain('code_challenge_method=S256');
    expect(AUTH_MD).toContain('Authorization: Bearer <access_token>');
    expect(AUTH_MD).toContain('refresh_token');
    expect(AUTH_MD).toContain('Do not probe registration with a test POST');
    expect(AUTH_MD).not.toContain('agent_auth');
  });
});
