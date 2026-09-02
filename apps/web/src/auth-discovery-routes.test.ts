import { describe, expect, it } from 'vitest';
import { AUTH_MD } from '@trace-flow/mcp-core';
import { GET as getAuthMd } from './app/auth.md/route';
import { GET as getProtectedResourceMetadata } from './app/.well-known/oauth-protected-resource/route';

describe('Auth.md routes', () => {
  it('serves agent registration instructions as Markdown', async () => {
    const response = getAuthMd();

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(await response.text()).toBe(AUTH_MD);
  });

  it('serves the canonical MCP protected-resource metadata with CORS', async () => {
    const response = getProtectedResourceMetadata();

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await response.json()).toEqual({
      resource: 'https://mcp.trace-flow.dev/mcp',
      authorization_servers: ['https://connect.trace-flow.dev'],
      scopes_supported: ['openid', 'profile', 'email'],
      bearer_methods_supported: ['header'],
      resource_name: 'Trace Flow MCP',
    });
  });
});
