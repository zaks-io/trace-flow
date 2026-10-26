import * as Sentry from '@sentry/cloudflare';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@trace-flow/logging';
import { sentryRequestPrivacy } from '@trace-flow/utils/sentry-tracing';
import { authenticate } from '../authenticate';
import { MCP_AUTHORIZATION_TTL_MS } from '../apiKeyAuth';

describe('MCP API key cache telemetry privacy in workerd', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps raw keys out of logs and exported spans on misses, hits and rejections', async () => {
    const key = crypto.randomUUID();
    const envelopes: string[] = [];
    const logs: string[] = [];
    const sink = (record: unknown) => {
      logs.push(String(record));
    };
    const logger = createLogger({
      service: 'mcp',
      runtime: 'cloudflare-worker',
      console: { debug: sink, info: sink, warn: sink, error: sink },
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json({ authorized: true, userId: 'privacy-user' }));
    const handler = {
      async fetch(request: Request, _env: Record<string, never>, _ctx: ExecutionContext) {
        const context = {
          req: { raw: request, header: (name: string) => request.headers.get(name) ?? undefined },
          env: {
            CONNECT_BASE_URL: 'https://connect.test',
            MCP_BACKEND_SHARED_SECRET: 'privacy-backend',
          },
          get: () => logger,
        };
        return Sentry.startSpan(
          { name: 'MCP authorization privacy probe', op: 'mcp.server' },
          async () => {
            expect(await authenticate(context)).toEqual({ userId: 'privacy-user' });
            expect(await authenticate(context)).toEqual({ userId: 'privacy-user' });
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            vi.spyOn(Date, 'now').mockReturnValue(Date.now() + MCP_AUTHORIZATION_TTL_MS);
            fetchSpy.mockResolvedValue(Response.json({ authorized: false, reason: 'forbidden' }));
            expect(await authenticate(context)).toHaveProperty('error.status', 403);
            fetchSpy.mockRejectedValue(new Error(`untrusted backend error with ${key}`));
            expect(await authenticate(context)).toHaveProperty('error.status', 503);
            logger.info('mcp.request_complete', { status: 200 });
            return new Response(null, { status: 204 });
          },
        );
      },
    };
    const worker = Sentry.withSentry<Record<string, never>, unknown, unknown, typeof handler>(
      () => ({
        dsn: 'https://public@example.test/1',
        tracesSampleRate: 1,
        skipOpenTelemetrySetup: true,
        ...sentryRequestPrivacy(),
        transport: () => ({
          send: async (envelope) => {
            envelopes.push(JSON.stringify(envelope));
            return { statusCode: 200 };
          },
          flush: async () => true,
        }),
      }),
      handler,
    );
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request('https://mcp.test/mcp', { headers: { Authorization: `Bearer ${key}` } }),
      {},
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(envelopes.length).toBeGreaterThan(0);
    expect(envelopes.join('\n')).toContain('MCP authorization privacy probe');
    expect(envelopes.join('\n')).not.toContain(key);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).toContain('mcp.api_key_auth_rejected');
    expect(logs.join('\n')).toContain('mcp.api_key_auth_unavailable');
    expect(logs.join('\n')).not.toContain(key);
  });
});
