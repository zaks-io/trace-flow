const MCP_RESOURCE_HOSTS = new Set([
  'mcp.trace-flow.dev',
  'trace-flow-mcp-dev.isaac-a46.workers.dev',
  'trace-flow-mcp-preview.isaac-a46.workers.dev',
]);

/**
 * Whether `redirectUri` is a loopback HTTP address (the CLI's local listener). The Collector login
 * flow delivers a freshly minted credential to this URL, so anything but `127.0.0.1` / `[::1]` /
 * `localhost` is rejected to prevent redirecting the secret to a third party.
 */
export function isLoopbackRedirect(redirectUri: string): boolean {
  try {
    const u = new URL(redirectUri);
    if (u.hash || u.username || u.password) return false;
    if (u.protocol !== 'http:') return false;
    return u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === 'localhost';
  } catch {
    return false;
  }
}

export function isSecureRedirectUri(redirectUri: string): boolean {
  try {
    const u = new URL(redirectUri);
    if (u.hash || u.username || u.password) return false;
    return u.protocol === 'https:' || isLoopbackRedirect(redirectUri);
  } catch {
    return false;
  }
}

export function canonicalizeMcpResource(resource: string): string | null {
  try {
    const u = new URL(resource);
    if (u.hash || u.username || u.password) return null;
    if (u.pathname !== '/mcp' || u.search) return null;

    if (isLoopbackRedirect(resource)) return u.toString();
    if (u.protocol !== 'https:') return null;

    return MCP_RESOURCE_HOSTS.has(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}
