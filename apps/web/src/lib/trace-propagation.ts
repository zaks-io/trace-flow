/**
 * Origins that may receive `sentry-trace` / `baggage` headers, for both the browser and the Next.js
 * server runtimes.
 *
 * Derived from the API URLs the app actually calls rather than hardcoded, so a browser trace joins
 * the Worker trace in every environment. The previous hardcoded `trace-flow.dev` pattern only matched
 * production and silently broke propagation against the `*.workers.dev` Workers used in dev and
 * preview.
 *
 * Convex and Auth0 are deliberately absent: they reject unknown request headers on preflight and have
 * no Sentry instrumentation to continue the trace anyway.
 */

/** Same fallback `lib/tinybird.ts` and `lib/bodies.ts` use when the public API URLs are unset. */
const LOCAL_API_ORIGIN = 'http://localhost:8788';

/**
 * Sentry substring-matches plain string targets, so `https://evil.example/?next=<our-origin>` would
 * qualify. Anchor each origin instead.
 */
function originPattern(origin: string): RegExp {
  return new RegExp(`^${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/|$)`);
}

export function apiTracePropagationTargets(): (string | RegExp)[] {
  const apiOrigins = [
    process.env.NEXT_PUBLIC_PIPES_API_URL,
    process.env.NEXT_PUBLIC_RAW_API_URL,
    process.env.NEXT_PUBLIC_API_URL,
    LOCAL_API_ORIGIN,
  ].flatMap((url) => {
    if (!url) return [];
    try {
      return [new URL(url).origin];
    } catch {
      return [];
    }
  });

  return [/^\//, ...[...new Set(apiOrigins)].map(originPattern)];
}
