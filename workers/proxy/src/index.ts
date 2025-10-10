import { generateId, getCurrentTimestamp } from '@observe/shared/utils';
import type { LLMRequest, LLMResponse, QueueMessage } from '@observe/shared/types';

interface Env {
  // CACHE?: KVNamespace;
  // REQUEST_QUEUE?: Queue<QueueMessage>;
  // STORAGE?: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return handleCors();
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const requestId = generateId();
    const startTime = getCurrentTimestamp();

    const requestBody = await request.text();
    let parsedRequest: unknown;

    try {
      parsedRequest = JSON.parse(requestBody);
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    const llmRequest: LLMRequest = {
      id: requestId,
      provider: 'openai',
      model: 'gpt-4',
      messages: [],
      timestamp: startTime,
    };

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: requestBody,
    });

    const endTime = getCurrentTimestamp();
    const responseBody = await response.text();

    const llmResponse: LLMResponse = {
      id: requestId,
      provider: 'openai',
      status: response.status,
      timestamp: endTime,
      latency: endTime - startTime,
    };

    // const queueMessage: QueueMessage = {
    //   requestId,
    //   request: llmRequest,
    //   response: llmResponse,
    //   requestBody,
    //   responseBody,
    // };
    // await env.REQUEST_QUEUE?.send(queueMessage);

    return new Response(responseBody, {
      status: response.status,
      headers: {
        'Content-Type': 'application/json',
        ...getCorsHeaders(),
      },
    });
  },
};

function handleCors(): Response {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(),
  });
}

function getCorsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
