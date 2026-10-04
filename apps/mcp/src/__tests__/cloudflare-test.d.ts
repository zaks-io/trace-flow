declare module 'cloudflare:test' {
  export const env: { MCP_LIMITER: RateLimit };
  export const SELF: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
}
