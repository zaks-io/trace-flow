export interface LLMRequest {
  id: string;
  provider: string;
  model: string;
  messages: unknown[];
  timestamp: number;
}

export interface LLMResponse {
  id: string;
  provider: string;
  status: number;
  timestamp: number;
  latency: number;
}

export interface QueueMessage {
  requestId: string;
  request: LLMRequest;
  response: LLMResponse;
  requestBody: string;
  responseBody: string;
}
