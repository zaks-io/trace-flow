import {
  createTransport,
  Scope,
  ServerRuntimeClient,
  startSpan,
  withScope,
  type Event,
} from '@sentry/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpBackend } from '../backend';
import { dispatchToolCall } from '../handler';
import { JsonRpcErrorCode, type ToolCallParams } from '../protocol';

const clients: ServerRuntimeClient[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) client.dispose();
});

function createSentryScope() {
  const events: Event[] = [];
  const transportRequests = vi.fn(async () => ({ statusCode: 200 }));
  const client = new ServerRuntimeClient({
    dsn: 'https://public@example.com/1',
    integrations: [],
    stackParser: () => [],
    tracesSampleRate: 1,
    beforeSend(event) {
      events.push(event);
      return event;
    },
    transport: (options) => createTransport(options, transportRequests),
  });
  client.init();
  clients.push(client);
  const scope = new Scope();
  scope.setClient(client);
  return { events, scope, transportRequests, flush: () => client.flush(1_000) };
}

function createBackend(overrides: Partial<McpBackend> = {}): McpBackend {
  return {
    getUserContext: async () => ({ enabled: true, retentionDays: 30 }),
    listApiKeys: async () => [],
    resolveKeyIds: async () => ({ ok: true, keyIds: ['key-1'] }),
    mintToken: async () => 'query-token',
    ...overrides,
  };
}

describe('MCP infrastructure error capture', () => {
  it('captures one sanitized backend failure on the explicit scope', async () => {
    const target = createSentryScope();
    const unrelated = createSentryScope();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const privateError = new Error('private backend response', {
      cause: new Error('private credential'),
    });
    const backend = createBackend({
      getUserContext: async () => {
        throw privateError;
      },
    });

    const response = await withScope(unrelated.scope, () =>
      dispatchToolCall(
        backend,
        'https://api.tinybird.test',
        1,
        { name: 'list_traces' },
        undefined,
        'analyst',
        target.scope,
      ),
    );
    await Promise.all([target.flush(), unrelated.flush()]);

    expect(response.error).toEqual({
      code: JsonRpcErrorCode.InternalError,
      message: 'Internal tool error',
    });
    expect(target.events).toHaveLength(1);
    expect(target.transportRequests).toHaveBeenCalledOnce();
    expect(target.events[0]?.exception?.values?.[0]?.value).toBe('MCP tool execution failed');
    expect(target.events[0]?.contexts?.trace?.trace_id).toBe(
      target.scope.getPropagationContext().traceId,
    );
    expect(unrelated.events).toEqual([]);
    const loggedError = consoleError.mock.calls[0]?.[1]?.error as Error;
    expect(loggedError).not.toBe(privateError);
    expect(loggedError.message).toBe('MCP tool execution failed');
    expect(loggedError.cause).toBeUndefined();
    expect(JSON.stringify(target.events)).not.toMatch(/private backend|private credential/);
    expect(String(loggedError.stack)).not.toMatch(/private backend|private credential/);
  });

  it('captures a Tinybird failure on the active host span without upstream content', async () => {
    const target = createSentryScope();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('private query response', { status: 500 }),
    );
    let traceId: string | undefined;
    let spanId: string | undefined;

    const response = await withScope(target.scope, () =>
      startSpan({ name: 'tools/call list_traces', op: 'mcp.server' }, async (span) => {
        ({ traceId, spanId } = span.spanContext());
        return dispatchToolCall(createBackend(), 'https://api.tinybird.test', 1, {
          name: 'list_traces',
        });
      }),
    );
    await target.flush();

    expect(response.error?.code).toBe(JsonRpcErrorCode.InternalError);
    expect(target.events).toHaveLength(1);
    expect(target.events[0]?.exception?.values?.[0]?.value).toBe('MCP tool execution failed');
    expect(target.events[0]?.contexts?.trace).toMatchObject({ trace_id: traceId, span_id: spanId });
    expect(JSON.stringify(target.events)).not.toContain('private query response');
  });

  it.each([
    { name: '' },
    { name: 'unknown_tool' },
    { name: 'list_traces', arguments: { api_key_ids: 'invalid' } },
    { name: 'get_trace', arguments: { trace_id: 'invalid' } },
  ] satisfies ToolCallParams[])(
    'does not capture expected validation for $name',
    async (params) => {
      const target = createSentryScope();
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      await dispatchToolCall(
        createBackend(),
        'https://api.tinybird.test',
        1,
        params,
        undefined,
        'mcp',
        target.scope,
      );
      await target.flush();

      expect(target.events).toEqual([]);
      expect(target.transportRequests).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    },
  );
});
