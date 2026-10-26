/// <reference types="@cloudflare/vitest-pool-workers/types" />

export {};

declare global {
  namespace Cloudflare {
    interface Env {
      MCP_LIMITER: RateLimit;
    }
  }
}
