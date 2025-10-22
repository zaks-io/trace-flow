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
      const res = await SELF.fetch('http://localhost/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Target': 'https://api.openai.com/v1/chat/completions',
        },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toHaveProperty('error', 'Missing API key');
    });

    it('should return 401 when API key is invalid', async () => {
      const res = await SELF.fetch('http://localhost/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Target': 'https://api.openai.com/v1/chat/completions',
          Authorization: 'Bearer invalid-key',
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

      const res = await SELF.fetch('http://localhost/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Target': 'https://api.openai.com/v1/chat/completions',
          Authorization: `Bearer ${expiredKey}`,
        },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toHaveProperty('error', 'Expired API key');
    });
  });

  describe('Request Validation', () => {
    it('should return 400 when X-Proxy-Target header is missing', async () => {
      await setupValidApiKey('test-key');

      const res = await SELF.fetch('http://localhost/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-key',
        },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toHaveProperty('error', 'Missing X-Proxy-Target header');
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
    it('should proxy successful non-streaming request', async () => {
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

      const res = await SELF.fetch('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Target': 'https://api.openai.com',
          Authorization: 'Bearer test-key',
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

      const res = await SELF.fetch('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Target': 'https://api.openai.com',
          Authorization: 'Bearer test-key',
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

      const res = await SELF.fetch('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Target': 'https://api.openai.com',
          Authorization: 'Bearer test-key',
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

      const res = await SELF.fetch('http://localhost/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Target': 'https://api.anthropic.com',
          Authorization: 'Bearer test-key',
        },
        body: JSON.stringify({ model: 'claude-3', messages: [] }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/event-stream');

      const text = await res.text();
      expect(text).toContain('message_start');

      await new Promise((resolve) => setTimeout(resolve, WAIT_UNTIL_DELAY));
    });

    it('should strip proxy auth headers and not forward them', async () => {
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

      await SELF.fetch('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Target': 'https://api.openai.com',
          Authorization: 'Bearer test-key',
          'X-API-Key': 'another-proxy-key',
          'Custom-Header': 'custom-value',
        },
        body: JSON.stringify({ model: 'gpt-4' }),
      });

      await new Promise((resolve) => setTimeout(resolve, WAIT_UNTIL_DELAY));

      expect(capturedHeaders).not.toBeNull();
      const headers = capturedHeaders!;
      expect(headers.has('X-Proxy-Target')).toBe(false);
      expect(headers.has('host')).toBe(false);
      expect(headers.has('Authorization')).toBe(false);
      expect(headers.has('X-API-Key')).toBe(false);
      expect(headers.get('Custom-Header')).toBe('custom-value');
    });

    it('should inject Bearer token for OpenAI with X-Provider-Api-Key', async () => {
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

      await SELF.fetch('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Target': 'https://api.openai.com',
          Authorization: 'Bearer test-key',
          'X-Provider-Api-Key': 'openai-key-123',
        },
        body: JSON.stringify({ model: 'gpt-4' }),
      });

      await new Promise((resolve) => setTimeout(resolve, WAIT_UNTIL_DELAY));

      expect(capturedHeaders).not.toBeNull();
      const headers = capturedHeaders!;
      expect(headers.has('X-Provider-Api-Key')).toBe(false);
      expect(headers.get('Authorization')).toBe('Bearer openai-key-123');
    });

    it('should inject x-api-key header for Anthropic with X-Provider-Api-Key', async () => {
      await setupValidApiKey('test-key');

      let capturedHeaders: Headers | null = null;

      fetchMock
        .get('https://api.anthropic.com')
        .intercept({
          path: '/v1/messages',
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

      await SELF.fetch('http://localhost/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Target': 'https://api.anthropic.com',
          Authorization: 'Bearer test-key',
          'X-Provider-Api-Key': 'anthropic-key-456',
        },
        body: JSON.stringify({ model: 'claude-3' }),
      });

      await new Promise((resolve) => setTimeout(resolve, WAIT_UNTIL_DELAY));

      expect(capturedHeaders).not.toBeNull();
      const headers = capturedHeaders!;
      expect(headers.has('X-Provider-Api-Key')).toBe(false);
      expect(headers.has('Authorization')).toBe(false);
      expect(headers.get('x-api-key')).toBe('anthropic-key-456');
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

      const res = await SELF.fetch('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Target': 'https://api.openai.com',
          Authorization: 'Bearer test-key',
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
});
