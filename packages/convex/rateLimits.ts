import { RateLimiter, MINUTE, HOUR } from '@convex-dev/rate-limiter';
import { components } from './_generated/api';

export const rateLimiter = new RateLimiter(components.rateLimiter, {
  // Unauthenticated public endpoints
  // joinWaitlist is keyed by email only — Convex mutations called from the
  // browser over WebSocket don't expose a trusted client IP. An HTTP-action
  // wrapper that reads `cf-connecting-ip` is the follow-up if email-keying
  // proves insufficient.
  joinWaitlistEmail: { kind: 'fixed window', rate: 3, period: HOUR },
  confirmEmail: { kind: 'fixed window', rate: 20, period: HOUR },

  // MCP OAuth endpoints (/mcp/register, /mcp/authorize, /mcp/callback, /mcp/token,
  // /collector/authorize) are intentionally NOT rate-limited at the application
  // layer. A DB-backed limiter writes a hot per-IP `rateLimits` row on every hop;
  // an interactive login hits several hops in a burst, the same-row writes race,
  // and Convex OCC conflicts surfaced as 503s that broke login (Sentry
  // TRACE-FLOW-1G). Per OAuth-server guidance (Duende), a single-org deployment
  // behind Cloudflare should not app-layer rate-limit these endpoints; abuse
  // protection lives at the Cloudflare edge instead.

  // Authenticated user/org actions
  initializeUser: { kind: 'fixed window', rate: 5, period: HOUR },
  createApiKey: { kind: 'fixed window', rate: 10, period: HOUR },
  mintCollectorCredential: { kind: 'fixed window', rate: 10, period: HOUR },
  generateTinybirdJwt: {
    kind: 'token bucket',
    rate: 60,
    period: MINUTE,
    capacity: 120,
    shards: 16,
  },
  bodyAccessToken: { kind: 'token bucket', rate: 120, period: MINUTE, capacity: 240 },
  analystSendMessage: { kind: 'token bucket', rate: 20, period: MINUTE, capacity: 40 },
  submitFeedback: { kind: 'fixed window', rate: 5, period: HOUR },
});
