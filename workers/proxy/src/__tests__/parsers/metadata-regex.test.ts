import { describe, it, expect } from 'vitest';
import {
  extractOpenAIMetadata,
  extractAnthropicMetadata,
  extractMetadataFromSSEData,
  extractMetadataFromResponseBody,
  extractTokenUsageFromSSEData,
} from '../../parsers/metadata-regex';

describe('extractOpenAIMetadata', () => {
  it('should extract basic OpenAI-compatible metadata', () => {
    const data =
      '{"id":"gen-123","model":"x-ai/grok-4-fast","object":"chat.completion","created":1762193197}';
    const metadata = extractOpenAIMetadata(data);

    expect(metadata.id).toBe('gen-123');
    expect(metadata.model).toBe('x-ai/grok-4-fast');
    expect(metadata.object).toBe('chat.completion');
    expect(metadata.created).toBe(1762193197);
  });

  it('should extract finish_reason', () => {
    const data = '{"choices":[{"finish_reason":"stop","native_finish_reason":"completed"}]}';
    const metadata = extractOpenAIMetadata(data);

    expect(metadata.finishReason).toBe('stop');
    expect(metadata.nativeFinishReason).toBe('completed');
  });

  it('should extract reasoning_tokens', () => {
    const data = '{"usage":{"completion_tokens_details":{"reasoning_tokens":973}}}';
    const metadata = extractOpenAIMetadata(data);

    expect(metadata.reasoningTokens).toBe(973);
  });

  it('should detect logprobs presence', () => {
    const data = '{"choices":[{"logprobs":{"token_logprobs":[]}}]}';
    const metadata = extractOpenAIMetadata(data);

    expect(metadata.hasLogprobs).toBe(true);
  });

  it('should extract refusal and reasoning', () => {
    const data = '{"choices":[{"message":{"refusal":"I cannot","reasoning":"Let me think"}}]}';
    const metadata = extractOpenAIMetadata(data);

    expect(metadata.refusal).toBe('I cannot');
    expect(metadata.reasoning).toBe('Let me think');
  });

  it('should handle null values', () => {
    const data = '{"choices":[{"message":{"refusal":null,"reasoning":null}}]}';
    const metadata = extractOpenAIMetadata(data);

    expect(metadata.refusal).toBe(null);
    expect(metadata.reasoning).toBe(null);
  });

  it('should accumulate metadata across multiple calls', () => {
    const data1 = '{"id":"gen-123","object":"chat.completion"}';
    const data2 = '{"choices":[{"finish_reason":"stop"}]}';

    const metadata1 = extractOpenAIMetadata(data1);
    const metadata2 = extractOpenAIMetadata(data2, metadata1);

    expect(metadata2.id).toBe('gen-123');
    expect(metadata2.object).toBe('chat.completion');
    expect(metadata2.finishReason).toBe('stop');
  });
});

describe('extractAnthropicMetadata', () => {
  it('should extract message ID and model from message_start', () => {
    const data =
      '{"type":"message_start","message":{"id":"msg_01BK1fpyqpgrrGvA4HTgaNCu","model":"claude-sonnet-4-5-20250929"}}';
    const metadata = extractAnthropicMetadata(data);

    expect(metadata.id).toBe('msg_01BK1fpyqpgrrGvA4HTgaNCu');
    expect(metadata.object).toBe('claude-sonnet-4-5-20250929'); // stored in object field
  });

  it('should extract stop_reason and stop_sequence', () => {
    const data = '{"stop_reason":"end_turn","stop_sequence":null}';
    const metadata = extractAnthropicMetadata(data);

    expect(metadata.stopReason).toBe('end_turn');
    expect(metadata.stopSequence).toBe(null);
  });

  it('should handle null stop_reason', () => {
    const data = '{"stop_reason":null}';
    const metadata = extractAnthropicMetadata(data);

    expect(metadata.stopReason).toBe(null);
  });
});

describe('extractMetadataFromSSEData', () => {
  it('should detect and extract OpenAI-compatible metadata', () => {
    const data = '{"id":"gen-123","object":"chat.completion","created":1762193197}';
    const metadata = extractMetadataFromSSEData(data);

    expect(metadata.id).toBe('gen-123');
    expect(metadata.object).toBe('chat.completion');
  });

  it('should detect and extract Anthropic metadata', () => {
    const data = '{"message":{"id":"msg_123","model":"claude-sonnet-4"}}';
    const metadata = extractMetadataFromSSEData(data);

    expect(metadata.id).toBe('msg_123');
    expect(metadata.object).toBe('claude-sonnet-4');
  });
});

describe('extractMetadataFromResponseBody', () => {
  it('should extract metadata from xAI response example', () => {
    const responseBody = JSON.stringify({
      id: 'gen-1762193197-iIVUcSEmFcIYnnwrKcG3',
      provider: 'xAI',
      model: 'x-ai/grok-4-fast',
      object: 'chat.completion',
      created: 1762193197,
      choices: [
        {
          logprobs: null,
          finish_reason: 'stop',
          native_finish_reason: 'completed',
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            refusal: null,
            reasoning: null,
            reasoning_details: [],
          },
        },
      ],
      usage: {
        prompt_tokens: 4270,
        completion_tokens: 7080,
        total_tokens: 11350,
        completion_tokens_details: {
          reasoning_tokens: 973,
        },
      },
    });

    const metadata = extractMetadataFromResponseBody(responseBody);

    expect(metadata.id).toBe('gen-1762193197-iIVUcSEmFcIYnnwrKcG3');
    expect(metadata.model).toBe('x-ai/grok-4-fast');
    expect(metadata.object).toBe('chat.completion');
    expect(metadata.created).toBe(1762193197);
    expect(metadata.finishReason).toBe('stop');
    expect(metadata.nativeFinishReason).toBe('completed');
    expect(metadata.reasoningTokens).toBe(973);
    expect(metadata.refusal).toBe(null);
    expect(metadata.reasoning).toBe(null);
  });

  it('should extract metadata from Anthropic response example', () => {
    const responseBody = JSON.stringify({
      type: 'message_start',
      message: {
        model: 'claude-sonnet-4-5-20250929',
        id: 'msg_01BK1fpyqpgrrGvA4HTgaNCu',
        type: 'message',
        role: 'assistant',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 8,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation: {
            ephemeral_5m_input_tokens: 0,
            ephemeral_1h_input_tokens: 0,
          },
          output_tokens: 3,
          service_tier: 'standard',
        },
      },
    });

    const metadata = extractMetadataFromResponseBody(responseBody);

    expect(metadata.id).toBe('msg_01BK1fpyqpgrrGvA4HTgaNCu');
    expect(metadata.object).toBe('claude-sonnet-4-5-20250929');
    expect(metadata.stopReason).toBeUndefined(); // null in JSON becomes undefined
  });
});

describe('extractTokenUsageFromSSEData', () => {
  it('should extract token usage from Anthropic message_start', () => {
    const data = JSON.stringify({
      type: 'message_start',
      message: {
        usage: {
          input_tokens: 8,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 3,
        },
      },
    });

    const usage = extractTokenUsageFromSSEData(data);

    expect(usage.input_tokens).toBe(8);
    expect(usage.output_tokens).toBe(3);
    expect(usage.cache_creation_input_tokens).toBe(0);
    expect(usage.cache_read_input_tokens).toBe(0);
  });

  it('should extract token usage from message_delta', () => {
    const data = JSON.stringify({
      type: 'message_delta',
      delta: {
        usage: {
          input_tokens: 10,
          output_tokens: 5,
        },
      },
    });

    const usage = extractTokenUsageFromSSEData(data);

    expect(usage.input_tokens).toBe(10);
    expect(usage.output_tokens).toBe(5);
  });

  it('should handle missing token fields', () => {
    const data = JSON.stringify({
      type: 'message_stop',
      usage: {
        input_tokens: 10,
      },
    });

    const usage = extractTokenUsageFromSSEData(data);

    expect(usage.input_tokens).toBe(10);
    expect(usage.output_tokens).toBeUndefined();
    expect(usage.cache_creation_input_tokens).toBeUndefined();
  });

  it('should handle empty data', () => {
    const usage = extractTokenUsageFromSSEData('{}');

    expect(usage.input_tokens).toBeUndefined();
    expect(usage.output_tokens).toBeUndefined();
  });
});
