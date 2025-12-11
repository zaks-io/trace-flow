import { describe, it, expect, beforeAll } from 'vitest';
import { env, fetchMock, SELF } from 'cloudflare:test';

const WAIT_UNTIL_DELAY = 100; // Time for waitUntil operations to complete

async function setupValidApiKey(key: string): Promise<void> {
  const keyData = {
    expiresAt: Date.now() + 86400000,
    createdAt: Date.now(),
  };
  await env.API_KEYS.put(key, JSON.stringify(keyData));
}

describe('Proxy Worker Integration', () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
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
    it('should include CORS headers', async () => {
      const res = await SELF.fetch('http://localhost/', {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://example.com',
        },
      });

      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
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

      fetchMock
        .get('https://api.openai.com')
        .intercept({ path: '/v1/chat/completions', method: 'POST' })
        .reply(200, JSON.stringify(mockResponse), {
          headers: { 'Content-Type': 'application/json' },
        });

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
      await new Promise((resolve) => setTimeout(resolve, WAIT_UNTIL_DELAY));

      // Verify R2 storage
      const stored = await env.STORAGE.list();
      expect(stored.objects.length).toBeGreaterThanOrEqual(2);
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

      fetchMock
        .get('https://api.anthropic.com')
        .intercept({ path: '/v1/messages', method: 'POST' })
        .reply(200, JSON.stringify(mockResponse), {
          headers: { 'Content-Type': 'application/json' },
        });

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

      await new Promise((resolve) => setTimeout(resolve, WAIT_UNTIL_DELAY));
    });

    it('should proxy successful request to OpenRouter', async () => {
      await setupValidApiKey('test-key');

      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [{ message: { content: 'Hello!' } }],
      };

      fetchMock
        .get('https://openrouter.ai')
        .intercept({ path: '/api/v1/chat/completions', method: 'POST' })
        .reply(200, JSON.stringify(mockResponse), {
          headers: { 'Content-Type': 'application/json' },
        });

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

      await new Promise((resolve) => setTimeout(resolve, WAIT_UNTIL_DELAY));
    });

    it('should proxy successful request to Groq', async () => {
      await setupValidApiKey('test-key');

      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [{ message: { content: 'Hello!' } }],
      };

      fetchMock
        .get('https://api.groq.com')
        .intercept({ path: '/openai/v1/chat/completions', method: 'POST' })
        .reply(200, JSON.stringify(mockResponse), {
          headers: { 'Content-Type': 'application/json' },
        });

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

      await new Promise((resolve) => setTimeout(resolve, WAIT_UNTIL_DELAY));
    });

    it('should handle error responses (4xx)', async () => {
      await setupValidApiKey('test-key');

      const errorBody = {
        error: {
          message: 'Invalid request',
          type: 'invalid_request_error',
        },
      };

      fetchMock
        .get('https://api.openai.com')
        .intercept({ path: '/v1/chat/completions', method: 'POST' })
        .reply(400, JSON.stringify(errorBody), {
          headers: { 'Content-Type': 'application/json' },
        });

      const res = await SELF.fetch('http://localhost/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Api-Key': 'test-key',
        },
        body: JSON.stringify({ invalid: 'data' }),
      });

      expect(res.status).toBe(400);

      await new Promise((resolve) => setTimeout(resolve, WAIT_UNTIL_DELAY));
    });

    it('should handle error responses (5xx)', async () => {
      await setupValidApiKey('test-key');

      const errorBody = {
        error: {
          message: 'Internal server error',
          type: 'server_error',
        },
      };

      fetchMock
        .get('https://api.openai.com')
        .intercept({ path: '/v1/chat/completions', method: 'POST' })
        .reply(500, JSON.stringify(errorBody), {
          headers: { 'Content-Type': 'application/json' },
        });

      const res = await SELF.fetch('http://localhost/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Api-Key': 'test-key',
        },
        body: JSON.stringify({ model: 'gpt-4' }),
      });

      expect(res.status).toBe(500);

      await new Promise((resolve) => setTimeout(resolve, WAIT_UNTIL_DELAY));
    });

    it('should detect and handle SSE streams', async () => {
      await setupValidApiKey('test-key');

      const sseData =
        'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';

      fetchMock
        .get('https://api.anthropic.com')
        .intercept({ path: '/v1/messages', method: 'POST' })
        .reply(200, sseData, {
          headers: { 'Content-Type': 'text/event-stream' },
        });

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

      await new Promise((resolve) => setTimeout(resolve, WAIT_UNTIL_DELAY));
    });

    it('should strip proxy auth header and pass through provider auth headers', async () => {
      await setupValidApiKey('test-key');

      let capturedHeaders: Headers | null = null;

      fetchMock
        .get('https://api.openai.com')
        .intercept({
          path: '/v1/chat/completions',
          method: 'POST',
        })
        .reply(
          200,
          (opts: { headers?: Record<string, string> }) => {
            capturedHeaders = new Headers(opts.headers as HeadersInit);
            return JSON.stringify({ ok: true });
          },
          {
            headers: { 'Content-Type': 'application/json' },
          },
        );

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

      await new Promise((resolve) => setTimeout(resolve, WAIT_UNTIL_DELAY));

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

      fetchMock
        .get('https://api.openai.com')
        .intercept({ path: '/v1/chat/completions', method: 'POST' })
        .reply(200, JSON.stringify({ result: 'ok' }), {
          headers: { 'Content-Type': 'application/json' },
        });

      const res = await SELF.fetch('http://localhost/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Api-Key': 'test-key',
        },
        body: JSON.stringify(largeBody),
      });

      expect(res.status).toBe(200);

      await new Promise((resolve) => setTimeout(resolve, WAIT_UNTIL_DELAY));

      // Verify request body was stored
      const requestKeys = await env.STORAGE.list({ prefix: 'requests/' });
      expect(requestKeys.objects.length).toBeGreaterThanOrEqual(1);
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

      fetchMock
        .get('https://api.openai.com')
        .intercept({ path: '/v1/chat/completions', method: 'POST' })
        .reply(200, JSON.stringify(mockResponse), {
          headers: { 'Content-Type': 'application/json' },
        });

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

      await new Promise((resolve) => setTimeout(resolve, WAIT_UNTIL_DELAY));

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

      fetchMock
        .get('https://api.openai.com')
        .intercept({ path: '/v1/chat/completions', method: 'POST' })
        .reply(200, JSON.stringify(mockResponse), {
          headers: { 'Content-Type': 'application/json' },
        });

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

      await new Promise((resolve) => setTimeout(resolve, WAIT_UNTIL_DELAY));

      // Verify bodies WERE stored
      const stored = await env.STORAGE.list();
      expect(stored.objects.length).toBeGreaterThanOrEqual(2);
    });

    it('should strip X-Trace-Flow-Omit-Body header before forwarding to provider', async () => {
      await setupValidApiKey('test-key');

      let capturedHeaders: Headers | null = null;

      fetchMock
        .get('https://api.openai.com')
        .intercept({
          path: '/v1/chat/completions',
          method: 'POST',
        })
        .reply(
          200,
          (opts: { headers?: Record<string, string> }) => {
            capturedHeaders = new Headers(opts.headers as HeadersInit);
            return JSON.stringify({ ok: true });
          },
          {
            headers: { 'Content-Type': 'application/json' },
          },
        );

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

      await new Promise((resolve) => setTimeout(resolve, WAIT_UNTIL_DELAY));

      expect(capturedHeaders).not.toBeNull();
      const headers = capturedHeaders!;
      expect(headers.has('X-Trace-Flow-Omit-Body')).toBe(false);
      // Verify other headers still pass through
      expect(headers.get('Authorization')).toBe('Bearer openai-key');
    });
  });
});
