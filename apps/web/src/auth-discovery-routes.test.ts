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

  it('redirects to the canonical MCP protected-resource metadata with CORS', () => {
    const response = getProtectedResourceMetadata();

    expect(response.status).toBe(307);
    expect(response.headers.get('Location')).toBe(
      'https://mcp.trace-flow.dev/.well-known/oauth-protected-resource',
    );
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});
