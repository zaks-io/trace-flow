import type { QueueMessage } from '@trace-flow/types';

export const baseQueueMessage: QueueMessage = {
  requestId: 'test-request-123',
  apiKey: 'test-api-key',
  targetUrl: 'https://api.openai.com/v1/chat/completions',
  request: {
    id: 'test-request-123',
    provider: 'openai',
    model: 'gpt-4',
    messages: [],
    timestamp: 1000,
  },
  response: {
    id: 'test-request-123',
    provider: 'openai',
    status: 200,
    timestamp: 1500,
    latency: 500,
  },
  timing: {
    requestStart: 1000,
    requestSent: 1100,
    responseReceived: 1150,
    firstTokenReceived: 1200,
    responseComplete: 1500,
  },
  receivedAt: 1000000000000000,
};
