import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueueMessage, StoredBodiesPayload, TraceDeliveryEnvelope } from '@trace-flow/types';
import { decryptStoredBodyPayload, analyticsKeyId } from '@trace-flow/utils';
import type { ProxyEnv } from '../context';
import { app } from '../index';
import { authorizeApiKeyRequest } from './api-key-authorization.test-support';

const bindings = env as unknown as ProxyEnv;
const routes = [
  {
    path: '/typesafe/v1/systemone',
    upstream: 'https://api.typesafe.ai/v1/systemone',
    provider: 'typesafe',
    requested: 'jev-latest',
    resolved: 'jev-1.13.0',
  },
  {
    path: '/openrouter/v1/systemone',
    upstream: 'https://openrouter.ai/api/v1/systemone',
    provider: 'openrouter',
    requested: 'jev-latest',
    resolved: 'typesafe/jev-1.13-20260917',
  },
  {
    path: '/openrouter/alpha/decisions',
    upstream: 'https://openrouter.ai/api/alpha/decisions',
    provider: 'openrouter',
    requested: '~typesafe/jev-latest',
    resolved: 'typesafe/jev-1.13-20260917',
  },
] as const;
type DecisionRoute = (typeof routes)[number];
const privateState = 'private-decision-state-canary';
const privateQuestion = 'private-decision-question-canary';
const privateAnswer = 'private-decision-answer-canary';

async function exchange(route: DecisionRoute, responseBody: string, status = 200) {
  const apiKey = `decision-${crypto.randomUUID()}`;
  const orgId = `org-${crypto.randomUUID()}`;
  await env.API_KEYS.put(apiKey, JSON.stringify({ expiresAt: Date.now() + 60_000, orgId }));
  await env.API_KEYS.put(
    `sub:${orgId}`,
    JSON.stringify({ tier: 'pro', status: 'active', monthlyUnits: 100_000, addonUnits: 0 }),
  );
  const previous = new Set(
    (await env.STORAGE.list({ prefix: 'trace-deliveries/' })).objects.map(({ key }) => key),
  );
  const requestBody = JSON.stringify({
    model: route.requested,
    state: { description: privateState },
    questions: {
      [privateQuestion]: { type: 'choice', options: [privateAnswer, 'wait'] },
      score: { type: 'score', legend: { low: 0, high: 1 } },
      noul: { type: 'noul' },
    },
  });
  const upstreamRequests: { headers: Headers; body: string }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const authorization = await authorizeApiKeyRequest(request.clone());
    if (authorization) return authorization;
    if (request.method !== 'POST' || request.url !== route.upstream) {
      throw new Error(`Unexpected transport: ${request.method} ${request.url}`);
    }
    upstreamRequests.push({ headers: request.headers, body: await request.text() });
    return new Response(responseBody, {
      status,
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'decision-provider-request-id',
        'retry-after': '7',
      },
    });
  });
  const ctx = createExecutionContext();
  const response = await app.fetch(
    new Request(`https://gateway.trace-flow.dev${route.path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer fixture-provider-key',
        'X-Trace-Flow-Api-Key': apiKey,
        'X-Trace-Flow-Omit-Body': 'false',
        'sentry-trace': `${'1'.repeat(32)}-${'2'.repeat(16)}-1`,
        traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`,
        tracestate: 'fixture=correlation',
        baggage: 'sentry-public_key=fixture-correlation',
      },
      body: requestBody,
    }),
    bindings,
    ctx,
  );
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toBe('application/json');
  expect(response.headers.get('x-request-id')).toBe('decision-provider-request-id');
  expect(response.headers.get('retry-after')).toBe('7');
  expect(await response.text()).toBe(responseBody);

  // EOF must already have a durable envelope, before waiting for queue publication.
  const deliveries = (await env.STORAGE.list({ prefix: 'trace-deliveries/' })).objects.filter(
    ({ key }) => !previous.has(key),
  );
  expect(deliveries).toHaveLength(1);
  const serialized = await (await env.STORAGE.get(deliveries[0]!.key))!.text();
  const envelope = JSON.parse(serialized) as TraceDeliveryEnvelope;
  expect(envelope.body?.encryptedPayload.alg).toBe('AES-GCM');
  expect(envelope.body?.key).toBe(`bodies/${(envelope.message as QueueMessage).requestId}`);
  for (const value of [privateState, privateQuestion, privateAnswer, apiKey]) {
    expect(serialized).not.toContain(value);
  }
  const body = envelope.body!;
  const captured = JSON.parse(
    await decryptStoredBodyPayload(body.encryptedPayload, {
      rootKeyBase64: bindings.BODY_ENCRYPTION_ROOT_KEY,
      orgId,
      objectKey: body.key,
    }),
  ) as StoredBodiesPayload;
  expect(captured.requestBody).toBe(requestBody);
  expect(captured.responseBody).toBe(responseBody);
  expect(upstreamRequests).toHaveLength(1);
  expect(upstreamRequests[0]!.body).toBe(requestBody);
  expect(upstreamRequests[0]!.headers.get('authorization')).toBe('Bearer fixture-provider-key');
  for (const name of [
    'x-trace-flow-api-key',
    'x-trace-flow-omit-body',
    'sentry-trace',
    'traceparent',
    'tracestate',
    'baggage',
  ]) {
    expect(upstreamRequests[0]!.headers.has(name)).toBe(false);
  }
  const message = envelope.message as QueueMessage;
  expect(message.apiKey).toBe(await analyticsKeyId(apiKey));
  expect(message.request).toMatchObject({ provider: route.provider, model: route.requested });
  expect(message.operationName).toBe('decision');
  expect(message.request.messages).toEqual([]);
  expect(message.inputMessages).toBeUndefined();
  expect(message.sseStreamData).toBeUndefined();
  await waitOnExecutionContext(ctx);
  return message;
}

describe('native Jev decision capture in workerd', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(routes)('forwards $path and accounts only top-level metadata', async (route) => {
    const body = JSON.stringify({
      id: 'decision-response-id',
      model: route.resolved,
      provider: 'TypeSafe',
      answers: {
        [privateQuestion]: { type: 'choice', choice: privateAnswer, confidence: 0.9 },
        score: { type: 'score', score: 0.5 },
        noul: { type: 'noul', probability: 0.7 },
        model: 'customer-model-canary',
        usage: { input_tokens: 999_999, output_tokens: 999_999, cost: 999 },
      },
      usage: { input_tokens: 476, output_tokens: 9, cost: 0.000019992 },
    });
    const message = await exchange(route, body);
    expect(message.responseMetadata).toEqual({ id: 'decision-response-id', model: route.resolved });
    expect(message.tokens).toEqual({
      promptTokens: 476,
      uncachedInputTokens: 476,
      completionTokens: 9,
      totalTokens: 485,
      ...(route.provider === 'openrouter' ? { upstreamCost: 0.000019992 } : {}),
    });
    expect(JSON.stringify(message)).not.toContain('customer-model-canary');
    expect(message.error).toBeUndefined();
  });

  it.each(routes.flatMap((route) => [401, 422, 429, 503].map((status) => ({ route, status }))))(
    'preserves $route.path request attribution on upstream $status',
    async ({ route, status }) => {
      const message = await exchange(
        route,
        JSON.stringify({
          error: { message: 'Upstream rejected decision', type: 'provider_error' },
        }),
        status,
      );
      expect(message.response.status).toBe(status);
      expect(message.responseMetadata?.model).toBeUndefined();
      expect(message.tokens).toBeUndefined();
      expect(message.error).toBeDefined();
    },
  );

  it.each(routes)('keeps malformed $path captures without guessing usage', async (route) => {
    const message = await exchange(
      route,
      '{"answers":{"usage":{"input_tokens":9000}},"usage":{"input_tokens":476',
    );
    expect(message.tokens).toBeUndefined();
    expect(message.responseMetadata).toBeUndefined();
  });
});
