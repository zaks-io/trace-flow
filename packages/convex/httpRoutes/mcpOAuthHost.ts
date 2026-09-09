const MCP_OAUTH_HOSTS = new Set([
  'connect.trace-flow.dev',
  'hardy-iguana-812.convex.site',
  'localhost',
  '127.0.0.1',
  '[::1]',
]);

export function isAllowedMcpOAuthHost(request: Request): boolean {
  return MCP_OAUTH_HOSTS.has(new URL(request.url).hostname);
}
