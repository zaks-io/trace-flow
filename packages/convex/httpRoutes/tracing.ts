import { SPAN_STATUS_ERROR } from '@sentry/core';
import type { HonoWithConvex } from 'convex-helpers/server/hono';
import type { ActionCtx } from '../_generated/server';
import { getConvexSentrySpan, withConvexHttpTracing } from '../convexTracing';
import { hasValidBearerSecret } from './shared';

const AUTHENTICATED_TRACE_ROUTES = {
  '/usage/record': 'USAGE_SYNC_SECRET',
  '/agent-ingest/claim-sessions': 'AGENT_INGEST_SHARED_SECRET',
  '/agent-ingest/compatibility-policy': 'AGENT_INGEST_SHARED_SECRET',
  '/mcp-backend/authorize-api-key': 'MCP_BACKEND_SHARED_SECRET',
  '/mcp-backend/context': 'MCP_BACKEND_SHARED_SECRET',
  '/mcp-backend/mint': 'MCP_BACKEND_SHARED_SECRET',
  '/worker/authorize-body-access': 'BODY_ACCESS_JWT_SECRET',
  '/worker/authorize-api-key': 'USAGE_SYNC_SECRET',
  '/worker/authorize-pipes-query': 'PIPES_API_SHARED_SECRET',
} as const;

export function registerHttpTracing(app: HonoWithConvex<ActionCtx>): void {
  for (const [path, secretName] of Object.entries(AUTHENTICATED_TRACE_ROUTES)) {
    app.use(path, async (c, next) => {
      const hasContext = c.req.header('sentry-trace') ?? c.req.header('traceparent');
      if (
        !hasContext ||
        !hasValidBearerSecret(c.req.header('Authorization'), process.env[secretName])
      ) {
        return next();
      }
      await withConvexHttpTracing(c.req.raw, `${c.req.method} ${path}`, async (scope) => {
        await next();
        const span = getConvexSentrySpan(scope)!;
        span.setAttribute('http.response.status_code', c.res.status);
        if (c.res.status >= 500) {
          span.setStatus({ code: SPAN_STATUS_ERROR });
          scope.captureException(new Error('Convex HTTP action failed'));
        }
      });
    });
  }
}
