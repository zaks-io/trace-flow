import { RateLimiter, MINUTE, HOUR } from '@convex-dev/rate-limiter';
import { components } from './_generated/api';

export const rateLimiter = new RateLimiter(components.rateLimiter, {
  // Unauthenticated public endpoints — keyed by IP (or email for joinWaitlist)
  joinWaitlistIp: { kind: 'fixed window', rate: 10, period: HOUR },
  joinWaitlistEmail: { kind: 'fixed window', rate: 3, period: HOUR },
  confirmEmail: { kind: 'fixed window', rate: 20, period: HOUR },
  mcpRegister: { kind: 'fixed window', rate: 10, period: HOUR },
  mcpAuthorize: { kind: 'fixed window', rate: 30, period: MINUTE },
  mcpTokenExchange: { kind: 'fixed window', rate: 60, period: MINUTE },

  // Authenticated user/org actions
  initializeUser: { kind: 'fixed window', rate: 5, period: HOUR },
  createApiKey: { kind: 'fixed window', rate: 10, period: HOUR },
  generateTinybirdJwt: { kind: 'token bucket', rate: 60, period: MINUTE, capacity: 120 },
  submitFeedback: { kind: 'fixed window', rate: 5, period: HOUR },
});
