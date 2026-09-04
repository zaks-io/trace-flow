import { describe, expect, it, vi } from 'vitest';
import type { TraceDeliveryEnvelope } from '@trace-flow/types';
import {
  buildTraceDeliveryKey,
  completeTraceDelivery,
  isTraceDeliveryEnvelope,
  isTraceDeliveryMessage,
  loadTraceDelivery,
} from './trace-delivery';

const envelope: TraceDeliveryEnvelope = {
  version: 1,
  message: {
    type: 'otlp',
    apiKey: 'key',
    traces: [],
    receivedAt: 1,
  },
};

const llmEnvelope: TraceDeliveryEnvelope = {
  version: 1,
  message: {
    requestId: 'request-id',
    apiKey: 'key',
    targetUrl: 'https://api.openai.com/v1/chat/completions',
    request: { id: 'request-id', provider: 'openai', model: 'gpt-4o', messages: [], timestamp: 1 },
    response: { id: 'request-id', provider: 'openai', status: 200, timestamp: 2, latency: 1 },
    timing: { requestStart: 1, requestSent: 1, responseReceived: 2, responseComplete: 2 },
    receivedAt: 1,
    orgId: 'org-1',
  },
  body: {
    key: 'bodies/request-id',
    orgId: 'org-1',
    encryptedPayload: {
      v: 1,
      alg: 'AES-GCM',
      kdf: 'HKDF-SHA-256',
      kid: 'v1',
      orgId: 'org-1',
      iv: 'iv',
      data: 'ciphertext',
    },
  },
};

describe('trace delivery helpers', () => {
  it('builds and validates delivery references', () => {
    const key = buildTraceDeliveryKey('delivery-id');
    expect(key).toBe('trace-deliveries/delivery-id');
    expect(isTraceDeliveryMessage({ type: 'delivery', key })).toBe(true);
    expect(() => buildTraceDeliveryKey('../other')).toThrow();
  });

  it('loads and validates an envelope', async () => {
    const storage = { get: vi.fn().mockResolvedValue({ json: async () => envelope }) };
    await expect(loadTraceDelivery(storage, buildTraceDeliveryKey('id'))).resolves.toEqual(
      envelope,
    );
    expect(isTraceDeliveryEnvelope(envelope)).toBe(true);
  });

  it('rejects invalid persisted data', async () => {
    const storage = { get: vi.fn().mockResolvedValue({ json: async () => ({ version: 1 }) }) };
    await expect(loadTraceDelivery(storage, buildTraceDeliveryKey('id'))).rejects.toThrow(
      'Invalid trace delivery envelope',
    );
  });

  it('enforces the canonical body key and matching organization boundary', () => {
    expect(isTraceDeliveryEnvelope(llmEnvelope)).toBe(true);
    expect(
      isTraceDeliveryEnvelope({
        ...llmEnvelope,
        body: { ...llmEnvelope.body, key: 'bodies/other-request' },
      }),
    ).toBe(false);
    expect(
      isTraceDeliveryEnvelope({
        ...llmEnvelope,
        body: { ...llmEnvelope.body, orgId: 'other-org' },
      }),
    ).toBe(false);
    expect(
      isTraceDeliveryEnvelope({
        ...llmEnvelope,
        body: {
          ...llmEnvelope.body,
          encryptedPayload: { ...llmEnvelope.body!.encryptedPayload, orgId: 'other-org' },
        },
      }),
    ).toBe(false);
  });

  it('rejects body data on OTLP deliveries', () => {
    expect(isTraceDeliveryEnvelope({ ...envelope, body: llmEnvelope.body })).toBe(false);
  });

  it('deletes only a validated delivery key', async () => {
    const storage = { delete: vi.fn().mockResolvedValue(undefined) };
    await completeTraceDelivery(storage, buildTraceDeliveryKey('id'));
    expect(storage.delete).toHaveBeenCalledWith('trace-deliveries/id');
    await expect(completeTraceDelivery(storage, 'bodies/id')).rejects.toThrow();
  });
});
