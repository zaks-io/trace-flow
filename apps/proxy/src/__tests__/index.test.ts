import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { isEncryptedStoredBodiesPayload, type StoredBodiesPayload } from '@trace-flow/types';
import { decryptStoredBodyPayload } from '@trace-flow/utils';

const WAIT_UNTIL_DELAY = 100;
const TEST_BODY_ENCRYPTION_ROOT_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const waitForAsyncOps = () => new Promise((resolve) => setTimeout(resolve, WAIT_UNTIL_DELAY));

interface UpstreamMatcher {
  method: string;
  origin: string;
  pathname: string;
}

/**
 * Replaces the removed `fetchMock` from `cloudflare:test`. Spies on
 * `globalThis.fetch` and replies only to the matched upstream; any other
 * request throws, preserving `fetchMock.disableNetConnect()` semantics.
 *
 * The proxy `tee()`s the request body and forwards one half here. A real
 * upstream drains that stream — so must this mock, otherwise the tee
 * back-pressures and the capture side fails with "Can't read from request
 * stream after response has been sent."
 */
function mockUpstream(
  matcher: UpstreamMatcher,
  status: number,
  body: BodyInit,
  responseInit?: ResponseInit,
): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (
      req.method === matcher.method &&
      url.origin === matcher.origin &&
      url.pathname === matcher.pathname
    ) {
      await req.arrayBuffer();
      return new Response(body, { status, ...responseInit });
    }
    throw new Error(`unexpected fetch: ${req.method} ${req.url}`);
  });
}

async function decryptStoredBodiesObject(
  objectKey: string,
  object: R2ObjectBody,
): Promise<StoredBodiesPayload> {
  const parsed: unknown = JSON.parse(await object.text());
  if (!isEncryptedStoredBodiesPayload(parsed)) {
    throw new Error('Expected encrypted stored body payload');
  }

  const orgId = object.customMetadata?.orgId;
  if (!orgId) {
    throw new Error('Expected stored body org metadata');
  }

  return JSON.parse(
    await decryptStoredBodyPayload(parsed, {
      rootKeyBase64: TEST_BODY_ENCRYPTION_ROOT_KEY,
      orgId,
      objectKey,
    }),
  ) as StoredBodiesPayload;
}

async function setupValidApiKey(key: string, orgId = 'org-test-123'): Promise<void> {
  const keyData = {
    expiresAt: Date.now() + 86400000,
    createdAt: Date.now(),
    orgId,
  };
  await env.API_KEYS.put(key, JSON.stringify(keyData));

  // Set up subscription config so usage checks pass
  const subConfig = {
    tier: 'pro',
    status: 'active',
    monthlyUnits: 100000,
    addonUnits: 0,
  };
  await env.API_KEYS.put(`sub:${orgId}`, JSON.stringify(subConfig));
}

describe('Proxy Worker Integration', () => {
  beforeEach(() => {
    // Default to throwing on any network access (replaces
    // fetchMock.disableNetConnect()); tests install matched mocks via
    // mockUpstream() which overrides this implementation.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      throw new Error(`unexpected fetch: ${req.method} ${req.url}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Authentication', () => {
    it('should return 401 when API key is missing', async () => {
      const res = await SELF.fetch('http://localhost/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toHaveProperty('error', 'Missing API key');
    });

    it('should return 401 when API key is invalid', async () => {
      const res = await SELF.fetch('http://localhost/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Api-Key': 'invalid-key',
        },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toHaveProperty('error', 'Invalid API key');
    });

    it('should return 401 when API key is expired', async () => {
      const expiredKey = 'expired-key';
      const keyData = {
        expiresAt: Date.now() - 1000,
        createdAt: Date.now() - 100000,
      };
      await env.API_KEYS.put(expiredKey, JSON.stringify(keyData));

      const res = await SELF.fetch('http://localhost/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Api-Key': expiredKey,
        },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toHaveProperty('error', 'Expired API key');
    });
  });

  describe('Route Validation', () => {
    it('should return 404 for invalid route', async () => {
      await setupValidApiKey('test-key');

      const res = await SELF.fetch('http://localhost/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Api-Key': 'test-key',
        },
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toHaveProperty('error', 'Invalid route');
    });

    it('should return 404 for unknown provider', async () => {
      await setupValidApiKey('test-key');

      const res = await SELF.fetch('http://localhost/unknown/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Api-Key': 'test-key',
        },
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toHaveProperty('error', 'Invalid route');
    });
  });

  describe('CORS', () => {
    it('should not include CORS headers (server-to-server only)', async () => {
      const res = await SELF.fetch('http://localhost/', {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://example.com',
        },
      });

      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });
  });

  describe('Proxy Requests', () => {
    it('should proxy successful non-streaming request to OpenAI', async () => {
      await setupValidApiKey('test-key');

      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [{ message: { content: 'Hello!' } }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
        },
      };

      mockUpstream(
        {
          method: 'POST',
          origin: 'https://api.openai.com',
          pathname: '/v1/chat/completions',
        },
        200,
        JSON.stringify(mockResponse),
        { headers: { 'Content-Type': 'application/json' } },
      );

      const res = await SELF.fetch('http://localhost/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Api-Key': 'test-key',
          Authorization: 'Bearer openai-key',
        },
        body: JSON.stringify({ model: 'gpt-4', messages: [] }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual(mockResponse);

      // Wait for async operations (waitUntil)
      await waitForAsyncOps();

      // Verify R2 storage
      const stored = await env.STORAGE.list({ prefix: 'bodies/' });
      expect(stored.objects.length).toBeGreaterThanOrEqual(1);
    });

    it('should proxy successful request to Anthropic', async () => {
      await setupValidApiKey('test-key');

      const mockResponse = {
        id: 'msg-123',
        content: [{ type: 'text', text: 'Hello!' }],
        usage: {
          input_tokens: 10,
          output_tokens: 20,
        },
      };

      mockUpstream(
        {
          method: 'POST',
          origin: 'https://api.anthropic.com',
          pathname: '/v1/messages',
        },
        200,
        JSON.stringify(mockResponse),
        { headers: { 'Content-Type': 'application/json' } },
      );

      const res = await SELF.fetch('http://localhost/anthropic/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Api-Key': 'test-key',
          'x-api-key': 'anthropic-key',
        },
        body: JSON.stringify({ model: 'claude-3-sonnet', messages: [] }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual(mockResponse);

      await waitForAsyncOps();
    });

    it('should proxy successful request to OpenRouter', async () => {
      await setupValidApiKey('test-key');

      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [{ message: { content: 'Hello!' } }],
      };

      mockUpstream(
        {
          method: 'POST',
          origin: 'https://openrouter.ai',
          pathname: '/api/v1/chat/completions',
        },
        200,
        JSON.stringify(mockResponse),
        { headers: { 'Content-Type': 'application/json' } },
      );

      const res = await SELF.fetch('http://localhost/openrouter/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Api-Key': 'test-key',
          Authorization: 'Bearer openrouter-key',
        },
        body: JSON.stringify({ model: 'openai/gpt-4', messages: [] }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual(mockResponse);

      await waitForAsyncOps();
    });

    it('should proxy successful request to Groq', async () => {
      await setupValidApiKey('test-key');

      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [{ message: { content: 'Hello!' } }],
      };

      mockUpstream(
        {
          method: 'POST',
          origin: 'https://api.groq.com',
          pathname: '/openai/v1/chat/completions',
        },
        200,
        JSON.stringify(mockResponse),
        { headers: { 'Content-Type': 'application/json' } },
      );

      const res = await SELF.fetch('http://localhost/groq/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Api-Key': 'test-key',
          Authorization: 'Bearer groq-key',
        },
        body: JSON.stringify({ model: 'llama-3.1-70b', messages: [] }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual(mockResponse);

      await waitForAsyncOps();
    });

    it('should handle error responses (4xx)', async () => {
      await setupValidApiKey('test-key');

      const errorBody = {
        error: {
          message: 'Invalid request',
          type: 'invalid_request_error',
        },
      };

      mockUpstream(
        {
          method: 'POST',
          origin: 'https://api.openai.com',
          pathname: '/v1/chat/completions',
        },
        400,
        JSON.stringify(errorBody),
        { headers: { 'Content-Type': 'application/json' } },
      );

      const res = await SELF.fetch('http://localhost/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Api-Key': 'test-key',
        },
        body: JSON.stringify({ invalid: 'data' }),
      });

      expect(res.status).toBe(400);

      await waitForAsyncOps();
    });

    it('should handle error responses (5xx)', async () => {
      await setupValidApiKey('test-key');

      const errorBody = {
        error: {
          message: 'Internal server error',
          type: 'server_error',
        },
      };

      mockUpstream(
        {
          method: 'POST',
          origin: 'https://api.openai.com',
          pathname: '/v1/chat/completions',
        },
        500,
        JSON.stringify(errorBody),
        { headers: { 'Content-Type': 'application/json' } },
      );

      const res = await SELF.fetch('http://localhost/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Api-Key': 'test-key',
        },
        body: JSON.stringify({ model: 'gpt-4' }),
      });

      expect(res.status).toBe(500);

      await waitForAsyncOps();
    });

    it('should detect and handle SSE streams', async () => {
      await setupValidApiKey('test-key');

      const sseData =
        'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';

      mockUpstream(
        {
          method: 'POST',
          origin: 'https://api.anthropic.com',
          pathname: '/v1/messages',
        },
        200,
        sseData,
        { headers: { 'Content-Type': 'text/event-stream' } },
      );

      const res = await SELF.fetch('http://localhost/anthropic/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Api-Key': 'test-key',
          'x-api-key': 'anthropic-key',
        },
        body: JSON.stringify({ model: 'claude-3', messages: [], stream: true }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/event-stream');

      const text = await res.text();
      expect(text).toContain('message_start');

      await waitForAsyncOps();
    });

    it('should strip proxy auth header and pass through provider auth headers', async () => {
      await setupValidApiKey('test-key');

      let capturedHeaders: Headers | null = null;

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const req = new Request(input, init);
        const url = new URL(req.url);
        if (
          req.method === 'POST' &&
          url.origin === 'https://api.openai.com' &&
          url.pathname === '/v1/chat/completions'
        ) {
          capturedHeaders = new Headers(req.headers);
          await req.arrayBuffer();
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new Error(`unexpected fetch: ${req.method} ${req.url}`);
      });

      await SELF.fetch('http://localhost/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Api-Key': 'test-key',
          Authorization: 'Bearer provider-auth-token',
          'x-api-key': 'provider-api-key',
          'Custom-Header': 'custom-value',
        },
        body: JSON.stringify({ model: 'gpt-4' }),
      });

      await waitForAsyncOps();

      expect(capturedHeaders).not.toBeNull();
      const headers = capturedHeaders!;
      expect(headers.has('host')).toBe(false);
      expect(headers.has('X-Trace-Flow-Api-Key')).toBe(false);
      // Provider auth headers should pass through unchanged
      expect(headers.get('Authorization')).toBe('Bearer provider-auth-token');
      expect(headers.get('x-api-key')).toBe('provider-api-key');
      expect(headers.get('Custom-Header')).toBe('custom-value');
    });

    it('should capture request body via tee()', async () => {
      await setupValidApiKey('test-key');

      const largeBody = { test: 'data', large: 'x'.repeat(1000) };

      mockUpstream(
        {
          method: 'POST',
          origin: 'https://api.openai.com',
          pathname: '/v1/chat/completions',
        },
        200,
        JSON.stringify({ result: 'ok' }),
        { headers: { 'Content-Type': 'application/json' } },
      );

      const res = await SELF.fetch('http://localhost/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Api-Key': 'test-key',
        },
        body: JSON.stringify(largeBody),
      });

      expect(res.status).toBe(200);

      await waitForAsyncOps();

      // Verify request body was stored
      const storedBodies = await env.STORAGE.list({ prefix: 'bodies/' });
      expect(storedBodies.objects.length).toBeGreaterThanOrEqual(1);
    });

    it('should return unredacted LLM JSON to client but redact PII in R2 bodies', async () => {
      await setupValidApiKey('test-key-pii-json');

      const secretEmail = 'leaky-user@example.com';
      const secretIp = '192.168.1.99';
      const secretCard = '4242424242424242';
      const requestEmail = 'request-pii@example.com';

      const mockResponse = {
        id: 'chatcmpl-pii',
        choices: [
          {
            message: {
              content: `Reply to ${secretEmail} from ${secretIp} cc ${secretCard}`,
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      };

      const keysBefore = new Set(
        (await env.STORAGE.list({ prefix: 'bodies/' })).objects.map((o) => o.key),
      );

      mockUpstream(
        {
          method: 'POST',
          origin: 'https://api.openai.com',
          pathname: '/v1/chat/completions',
        },
        200,
        JSON.stringify(mockResponse),
        { headers: { 'Content-Type': 'application/json' } },
      );

      const res = await SELF.fetch('http://localhost/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Api-Key': 'test-key-pii-json',
        },
        body: JSON.stringify({
          model: 'gpt-4',
          messages: [{ role: 'user', content: `Question from ${requestEmail}` }],
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual(mockResponse);
      expect(JSON.stringify(body)).toContain(secretEmail);
      expect(JSON.stringify(body)).toContain(secretIp);

      await waitForAsyncOps();

      const after = await env.STORAGE.list({ prefix: 'bodies/' });
      const newKey = after.objects.find((o) => !keysBefore.has(o.key))?.key;
      if (!newKey) throw new Error('expected a new R2 bodies object for this request');

      const obj = await env.STORAGE.get(newKey);
      if (!obj) throw new Error('expected the new R2 bodies object to exist');
      const stored = await decryptStoredBodiesObject(newKey, obj);

      expect(stored.requestBody).not.toContain(requestEmail);
      expect(stored.requestBody).toContain('[REDACTED]');
      expect(stored.responseBody).not.toContain(secretEmail);
      expect(stored.responseBody).not.toContain(secretIp);
      expect(stored.responseBody).not.toContain(secretCard);
      expect(stored.responseBody).toContain('[REDACTED]');
    });

    it('should return unredacted SSE stream to client but redact PII in R2 bodies', async () => {
      await setupValidApiKey('test-key-pii-sse');

      const secretEmail = 'stream-leak@example.com';
      const requestEmail = 'sse-request-pii@example.com';
      const sseBody = `data: {"choices":[{"delta":{"content":"${secretEmail}"}}]}\n\ndata: [DONE]\n\n`;

      const keysBefore = new Set(
        (await env.STORAGE.list({ prefix: 'bodies/' })).objects.map((o) => o.key),
      );

      mockUpstream(
        {
          method: 'POST',
          origin: 'https://api.openai.com',
          pathname: '/v1/chat/completions',
        },
        200,
        sseBody,
        { headers: { 'Content-Type': 'text/event-stream' } },
      );

      const res = await SELF.fetch('http://localhost/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Api-Key': 'test-key-pii-sse',
        },
        body: JSON.stringify({
          model: 'gpt-4',
          messages: [{ role: 'user', content: requestEmail }],
          stream: true,
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/event-stream');
      const text = await res.text();
      expect(text).toContain(secretEmail);

      await waitForAsyncOps();

      const after = await env.STORAGE.list({ prefix: 'bodies/' });
      const newKey = after.objects.find((o) => !keysBefore.has(o.key))?.key;
      if (!newKey) throw new Error('expected a new R2 bodies object for this request');

      const obj = await env.STORAGE.get(newKey);
      if (!obj) throw new Error('expected the new R2 bodies object to exist');
      const stored = await decryptStoredBodiesObject(newKey, obj);

      expect(stored.requestBody).not.toContain(requestEmail);
      expect(stored.requestBody).toContain('[REDACTED]');
      expect(stored.responseBody).not.toContain(secretEmail);
      expect(stored.responseBody).toContain('[REDACTED]');
    });
  });

  describe('OTLP Rejection Feedback', () => {
    it('should return rejectedSpans when usage is denied', async () => {
      const key = 'otlp-exhausted-key';
      const orgId = 'org-otlp-exhausted';
      const keyData = {
        expiresAt: Date.now() + 86400000,
        createdAt: Date.now(),
        orgId,
      };
      await env.API_KEYS.put(key, JSON.stringify(keyData));

      const subConfig = {
        tier: 'hobby',
        status: 'active',
        monthlyUnits: 0,
        addonUnits: 0,
      };
      await env.API_KEYS.put(`sub:${orgId}`, JSON.stringify(subConfig));

      const otlpRequest = {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: 'abc123',
                    spanId: 'span1',
                    name: 'test-span',
                    startTimeUnixNano: '1000000000',
                    endTimeUnixNano: '2000000000',
                  },
                  {
                    traceId: 'abc123',
                    spanId: 'span2',
                    name: 'test-span-2',
                    startTimeUnixNano: '1000000000',
                    endTimeUnixNano: '2000000000',
                  },
                ],
              },
            ],
          },
        ],
      };

      const res = await SELF.fetch('http://localhost/v1/traces', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Api-Key': key,
        },
        body: JSON.stringify(otlpRequest),
      });

      expect(res.status).toBe(200);
      const body: { partialSuccess: { rejectedSpans: number; errorMessage: string } } =
        await res.json();
      expect(body.partialSuccess.rejectedSpans).toBeGreaterThan(0);
      expect(body.partialSuccess.errorMessage).toBe('Usage limit exceeded');
    });
  });

  describe('Soft Enforcement', () => {
    it('should proxy request and set recording=false when usage is exceeded', async () => {
      const key = 'usage-exceeded-key';
      const orgId = 'org-exhausted';
      const keyData = {
        expiresAt: Date.now() + 86400000,
        createdAt: Date.now(),
        orgId,
      };
      await env.API_KEYS.put(key, JSON.stringify(keyData));

      const subConfig = {
        tier: 'hobby',
        status: 'active',
        monthlyUnits: 0,
        addonUnits: 0,
      };
      await env.API_KEYS.put(`sub:${orgId}`, JSON.stringify(subConfig));

      // Clear any existing storage so the no-storage assertion is exact.
      const existingObjects = await env.STORAGE.list();
      for (const obj of existingObjects.objects) {
        await env.STORAGE.delete(obj.key);
      }

      const mockResponse = { id: 'chatcmpl-123', choices: [{ message: { content: 'Hello!' } }] };

      mockUpstream(
        {
          method: 'POST',
          origin: 'https://api.openai.com',
          pathname: '/v1/chat/completions',
        },
        200,
        JSON.stringify(mockResponse),
        { headers: { 'Content-Type': 'application/json' } },
      );

      const res = await SELF.fetch('http://localhost/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Api-Key': key,
          Authorization: 'Bearer openai-key',
        },
        body: JSON.stringify({ model: 'gpt-4', messages: [] }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('X-Trace-Flow-Recording')).toBe('false');
      expect(res.headers.get('X-Trace-Flow-Recording-Reason')).toBe('exceeded');

      const body = await res.json();
      expect(body).toEqual(mockResponse);

      await waitForAsyncOps();

      // No R2 storage should happen when not recording
      const stored = await env.STORAGE.list({ prefix: 'bodies/' });
      expect(stored.objects.length).toBe(0);
    });

    it('should proxy request when account is suspended', async () => {
      const key = 'suspended-key';
      const orgId = 'org-suspended';
      const keyData = {
        expiresAt: Date.now() + 86400000,
        createdAt: Date.now(),
        orgId,
      };
      await env.API_KEYS.put(key, JSON.stringify(keyData));

      const subConfig = {
        tier: 'pro',
        status: 'suspended',
        monthlyUnits: 100000,
        addonUnits: 0,
      };
      await env.API_KEYS.put(`sub:${orgId}`, JSON.stringify(subConfig));

      const mockResponse = { id: 'chatcmpl-456', choices: [{ message: { content: 'Hi!' } }] };

      mockUpstream(
        {
          method: 'POST',
          origin: 'https://api.openai.com',
          pathname: '/v1/chat/completions',
        },
        200,
        JSON.stringify(mockResponse),
        { headers: { 'Content-Type': 'application/json' } },
      );

      const res = await SELF.fetch('http://localhost/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Api-Key': key,
          Authorization: 'Bearer openai-key',
        },
        body: JSON.stringify({ model: 'gpt-4', messages: [] }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('X-Trace-Flow-Recording')).toBe('false');
      expect(res.headers.get('X-Trace-Flow-Recording-Reason')).toBe('suspended');

      await waitForAsyncOps();
    });

    it('should proxy request when account is canceled', async () => {
      const key = 'canceled-key';
      const orgId = 'org-canceled';
      const keyData = {
        expiresAt: Date.now() + 86400000,
        createdAt: Date.now(),
        orgId,
      };
      await env.API_KEYS.put(key, JSON.stringify(keyData));

      const subConfig = {
        tier: 'pro',
        status: 'canceled',
        monthlyUnits: 100000,
        addonUnits: 0,
      };
      await env.API_KEYS.put(`sub:${orgId}`, JSON.stringify(subConfig));

      const mockResponse = { id: 'chatcmpl-789', choices: [{ message: { content: 'Hey!' } }] };

      mockUpstream(
        {
          method: 'POST',
          origin: 'https://api.openai.com',
          pathname: '/v1/chat/completions',
        },
        200,
        JSON.stringify(mockResponse),
        { headers: { 'Content-Type': 'application/json' } },
      );

      const res = await SELF.fetch('http://localhost/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Api-Key': key,
          Authorization: 'Bearer openai-key',
        },
        body: JSON.stringify({ model: 'gpt-4', messages: [] }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('X-Trace-Flow-Recording')).toBe('false');
      expect(res.headers.get('X-Trace-Flow-Recording-Reason')).toBe('canceled');

      await waitForAsyncOps();
    });

    it('should proxy request when subscription KV data is corrupt', async () => {
      const key = 'corrupt-sub-key';
      const orgId = 'org-corrupt-sub';
      const keyData = {
        expiresAt: Date.now() + 86400000,
        createdAt: Date.now(),
        orgId,
      };
      await env.API_KEYS.put(key, JSON.stringify(keyData));
      await env.API_KEYS.put(`sub:${orgId}`, 'not valid json');

      const mockResponse = { id: 'chatcmpl-corrupt', choices: [{ message: { content: 'Hi!' } }] };

      mockUpstream(
        {
          method: 'POST',
          origin: 'https://api.openai.com',
          pathname: '/v1/chat/completions',
        },
        200,
        JSON.stringify(mockResponse),
        { headers: { 'Content-Type': 'application/json' } },
      );

      const res = await SELF.fetch('http://localhost/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Api-Key': key,
          Authorization: 'Bearer openai-key',
        },
        body: JSON.stringify({ model: 'gpt-4', messages: [] }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('X-Trace-Flow-Recording')).toBe('false');
      // Corrupt billing data resolves to not_found in the cache fetcher
      expect(res.headers.get('X-Trace-Flow-Recording-Reason')).toBe('no_subscription');

      await waitForAsyncOps();
    });

    it('should set recording=true header on successful proxied requests', async () => {
      await setupValidApiKey('test-key-recording');

      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [{ message: { content: 'Hello!' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      };

      mockUpstream(
        {
          method: 'POST',
          origin: 'https://api.openai.com',
          pathname: '/v1/chat/completions',
        },
        200,
        JSON.stringify(mockResponse),
        { headers: { 'Content-Type': 'application/json' } },
      );

      const res = await SELF.fetch('http://localhost/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Api-Key': 'test-key-recording',
          Authorization: 'Bearer openai-key',
        },
        body: JSON.stringify({ model: 'gpt-4', messages: [] }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('X-Trace-Flow-Recording')).toBe('true');

      await waitForAsyncOps();
    });
  });

  describe('Body Omission', () => {
    it("should not store bodies when X-Trace-Flow-Omit-Body is 'true'", async () => {
      await setupValidApiKey('test-key');

      // Clear any existing storage
      const existingObjects = await env.STORAGE.list();
      for (const obj of existingObjects.objects) {
        await env.STORAGE.delete(obj.key);
      }

      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [{ message: { content: 'Hello!' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      };

      mockUpstream(
        {
          method: 'POST',
          origin: 'https://api.openai.com',
          pathname: '/v1/chat/completions',
        },
        200,
        JSON.stringify(mockResponse),
        { headers: { 'Content-Type': 'application/json' } },
      );

      const res = await SELF.fetch('http://localhost/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Api-Key': 'test-key',
          'X-Trace-Flow-Omit-Body': 'true',
          Authorization: 'Bearer openai-key',
        },
        body: JSON.stringify({ model: 'gpt-4', messages: [] }),
      });

      expect(res.status).toBe(200);

      await waitForAsyncOps();

      // Verify NO bodies were stored
      const stored = await env.STORAGE.list();
      expect(stored.objects.length).toBe(0);
    });

    it('should store bodies when X-Trace-Flow-Omit-Body header is absent', async () => {
      await setupValidApiKey('test-key');

      // Clear any existing storage
      const existingObjects = await env.STORAGE.list();
      for (const obj of existingObjects.objects) {
        await env.STORAGE.delete(obj.key);
      }

      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [{ message: { content: 'Hello!' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      };

      mockUpstream(
        {
          method: 'POST',
          origin: 'https://api.openai.com',
          pathname: '/v1/chat/completions',
        },
        200,
        JSON.stringify(mockResponse),
        { headers: { 'Content-Type': 'application/json' } },
      );

      const res = await SELF.fetch('http://localhost/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Api-Key': 'test-key',
          Authorization: 'Bearer openai-key',
        },
        body: JSON.stringify({ model: 'gpt-4', messages: [] }),
      });

      expect(res.status).toBe(200);

      await waitForAsyncOps();

      // Verify bodies WERE stored
      const stored = await env.STORAGE.list({ prefix: 'bodies/' });
      expect(stored.objects.length).toBeGreaterThanOrEqual(1);

      const firstStoredObject = stored.objects[0];
      expect(firstStoredObject).toBeDefined();
      const storedObject = await env.STORAGE.get(firstStoredObject!.key);
      expect(storedObject).not.toBeNull();
      const storedText = await storedObject!.text();
      expect(storedText).not.toContain('gpt-4');
      expect(storedText).not.toContain('Hello!');
    });

    it('should strip X-Trace-Flow-Omit-Body header before forwarding to provider', async () => {
      await setupValidApiKey('test-key');

      let capturedHeaders: Headers | null = null;

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const req = new Request(input, init);
        const url = new URL(req.url);
        if (
          req.method === 'POST' &&
          url.origin === 'https://api.openai.com' &&
          url.pathname === '/v1/chat/completions'
        ) {
          capturedHeaders = new Headers(req.headers);
          await req.arrayBuffer();
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new Error(`unexpected fetch: ${req.method} ${req.url}`);
      });

      await SELF.fetch('http://localhost/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Api-Key': 'test-key',
          'X-Trace-Flow-Omit-Body': 'true',
          Authorization: 'Bearer openai-key',
        },
        body: JSON.stringify({ model: 'gpt-4' }),
      });

      await waitForAsyncOps();

      expect(capturedHeaders).not.toBeNull();
      const headers = capturedHeaders!;
      expect(headers.has('X-Trace-Flow-Omit-Body')).toBe(false);
      // Verify other headers still pass through
      expect(headers.get('Authorization')).toBe('Bearer openai-key');
    });
  });
});
