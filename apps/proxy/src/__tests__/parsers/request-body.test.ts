import { describe, it, expect } from 'vitest';
import {
  parseAnthropicRequestBody,
  parseOpenAIStyleRequestBody,
  extractToolResultIds,
  extractToolUseFromContentBlocks,
} from '../../parsers/request-body';

describe('parseAnthropicRequestBody', () => {
  it('should return null for invalid JSON', () => {
    const result = parseAnthropicRequestBody('invalid json');
    expect(result).toBeNull();
  });

  it('should return null when messages array is missing', () => {
    const result = parseAnthropicRequestBody(JSON.stringify({ model: 'claude-3' }));
    expect(result).toBeNull();
  });

  it('should parse simple user message with string content', () => {
    const body = JSON.stringify({
      model: 'claude-3-sonnet-20240229',
      messages: [{ role: 'user', content: 'Hello, world!' }],
    });

    const result = parseAnthropicRequestBody(body);

    expect(result).toEqual([
      {
        role: 'user',
        index: 0,
        contentBlocks: [{ index: 0, type: 'text' }],
      },
    ]);
  });

  it('should handle system message', () => {
    const body = JSON.stringify({
      model: 'claude-3-sonnet-20240229',
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const result = parseAnthropicRequestBody(body);

    expect(result).toEqual([
      {
        role: 'system',
        index: 0,
        contentBlocks: [{ index: 0, type: 'text' }],
      },
      {
        role: 'user',
        index: 1,
        contentBlocks: [{ index: 0, type: 'text' }],
      },
    ]);
  });

  it('should parse message with array content blocks', () => {
    const body = JSON.stringify({
      model: 'claude-3-sonnet-20240229',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            { type: 'image', source: { type: 'base64', data: 'abc123' } },
          ],
        },
      ],
    });

    const result = parseAnthropicRequestBody(body);

    expect(result).toEqual([
      {
        role: 'user',
        index: 0,
        contentBlocks: [
          { index: 0, type: 'text' },
          { index: 1, type: 'image' },
        ],
      },
    ]);
  });

  it('should parse assistant message with tool_use', () => {
    const body = JSON.stringify({
      model: 'claude-3-sonnet-20240229',
      messages: [
        { role: 'user', content: 'Get the weather' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will get the weather for you.' },
            {
              type: 'tool_use',
              id: 'toolu_01abc123',
              name: 'get_weather',
              input: { location: 'SF' },
            },
          ],
        },
      ],
    });

    const result = parseAnthropicRequestBody(body);

    expect(result).toEqual([
      {
        role: 'user',
        index: 0,
        contentBlocks: [{ index: 0, type: 'text' }],
      },
      {
        role: 'assistant',
        index: 1,
        contentBlocks: [
          { index: 0, type: 'text' },
          { index: 1, type: 'tool_use', toolUseId: 'toolu_01abc123', toolName: 'get_weather' },
        ],
      },
    ]);
  });

  it('should parse user message with tool_result', () => {
    const body = JSON.stringify({
      model: 'claude-3-sonnet-20240229',
      messages: [
        { role: 'user', content: 'Get the weather' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_01abc123',
              name: 'get_weather',
              input: { location: 'SF' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_01abc123',
              content: 'Sunny, 72°F',
            },
          ],
        },
      ],
    });

    const result = parseAnthropicRequestBody(body);

    expect(result).toEqual([
      {
        role: 'user',
        index: 0,
        contentBlocks: [{ index: 0, type: 'text' }],
      },
      {
        role: 'assistant',
        index: 1,
        contentBlocks: [
          { index: 0, type: 'tool_use', toolUseId: 'toolu_01abc123', toolName: 'get_weather' },
        ],
      },
      {
        role: 'user',
        index: 2,
        contentBlocks: [{ index: 0, type: 'tool_result', toolResultId: 'toolu_01abc123' }],
      },
    ]);
  });

  it('should handle multi-turn conversation', () => {
    const body = JSON.stringify({
      model: 'claude-3-sonnet-20240229',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' },
        { role: 'assistant', content: 'I am doing well!' },
      ],
    });

    const result = parseAnthropicRequestBody(body);

    expect(result).toHaveLength(4);
    expect(result?.[0]?.role).toBe('user');
    expect(result?.[0]?.index).toBe(0);
    expect(result?.[1]?.role).toBe('assistant');
    expect(result?.[1]?.index).toBe(1);
    expect(result?.[2]?.role).toBe('user');
    expect(result?.[2]?.index).toBe(2);
    expect(result?.[3]?.role).toBe('assistant');
    expect(result?.[3]?.index).toBe(3);
  });
});

describe('extractToolResultIds', () => {
  it('should return empty array when no tool results', () => {
    const inputMessages = [
      { role: 'user' as const, index: 0, contentBlocks: [{ index: 0, type: 'text' as const }] },
    ];

    const result = extractToolResultIds(inputMessages);

    expect(result).toEqual([]);
  });

  it('should extract tool_use_id from tool_result blocks', () => {
    const inputMessages = [
      {
        role: 'user' as const,
        index: 0,
        contentBlocks: [
          { index: 0, type: 'tool_result' as const, toolResultId: 'toolu_01abc123' },
          { index: 1, type: 'tool_result' as const, toolResultId: 'toolu_02def456' },
        ],
      },
    ];

    const result = extractToolResultIds(inputMessages);

    expect(result).toEqual(['toolu_01abc123', 'toolu_02def456']);
  });

  it('should extract tool_use_ids from multiple messages', () => {
    const inputMessages = [
      {
        role: 'user' as const,
        index: 0,
        contentBlocks: [{ index: 0, type: 'tool_result' as const, toolResultId: 'toolu_01abc' }],
      },
      {
        role: 'assistant' as const,
        index: 1,
        contentBlocks: [{ index: 0, type: 'text' as const }],
      },
      {
        role: 'user' as const,
        index: 2,
        contentBlocks: [{ index: 0, type: 'tool_result' as const, toolResultId: 'toolu_02def' }],
      },
    ];

    const result = extractToolResultIds(inputMessages);

    expect(result).toEqual(['toolu_01abc', 'toolu_02def']);
  });
});

describe('extractToolUseFromContentBlocks', () => {
  it('should return empty array when no tool_use blocks', () => {
    const contentBlocks = [{ type: 'text', startTimestamp: 1000, stopTimestamp: 1100 }];

    const result = extractToolUseFromContentBlocks(contentBlocks);

    expect(result).toEqual([]);
  });

  it('should extract tool_use blocks with complete info', () => {
    const contentBlocks = [
      { type: 'text', startTimestamp: 1000, stopTimestamp: 1100 },
      {
        type: 'tool_use',
        toolUseId: 'toolu_01abc123',
        toolName: 'get_weather',
        startTimestamp: 1200,
        stopTimestamp: 1300,
      },
      {
        type: 'tool_use',
        toolUseId: 'toolu_02def456',
        toolName: 'search',
        startTimestamp: 1400,
        stopTimestamp: 1500,
      },
    ];

    const result = extractToolUseFromContentBlocks(contentBlocks);

    expect(result).toEqual([
      { toolUseId: 'toolu_01abc123', toolName: 'get_weather', stopTimestamp: 1300 },
      { toolUseId: 'toolu_02def456', toolName: 'search', stopTimestamp: 1500 },
    ]);
  });

  it('should skip tool_use blocks missing required fields', () => {
    const contentBlocks = [
      {
        type: 'tool_use',
        toolUseId: 'toolu_01abc123',
        // missing toolName
        stopTimestamp: 1300,
      },
      {
        type: 'tool_use',
        // missing toolUseId
        toolName: 'search',
        stopTimestamp: 1500,
      },
      {
        type: 'tool_use',
        toolUseId: 'toolu_03ghi',
        toolName: 'calc',
        // missing stopTimestamp
      },
    ];

    const result = extractToolUseFromContentBlocks(contentBlocks);

    expect(result).toEqual([]);
  });
});

describe('parseOpenAIStyleRequestBody', () => {
  it('should return null for invalid JSON', () => {
    const result = parseOpenAIStyleRequestBody('invalid json');
    expect(result).toBeNull();
  });

  it('should return null when messages array is missing', () => {
    const result = parseOpenAIStyleRequestBody(JSON.stringify({ model: 'gpt-4' }));
    expect(result).toBeNull();
  });

  it('should parse simple user message', () => {
    const body = JSON.stringify({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello, world!' }],
    });

    const result = parseOpenAIStyleRequestBody(body);

    expect(result).toEqual([
      {
        role: 'user',
        index: 0,
        contentBlocks: [{ index: 0, type: 'text' }],
      },
    ]);
  });

  it('should parse system message in messages array', () => {
    const body = JSON.stringify({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ],
    });

    const result = parseOpenAIStyleRequestBody(body);

    expect(result).toEqual([
      {
        role: 'system',
        index: 0,
        contentBlocks: [{ index: 0, type: 'text' }],
      },
      {
        role: 'user',
        index: 1,
        contentBlocks: [{ index: 0, type: 'text' }],
      },
    ]);
  });

  it('should parse assistant message with tool_calls', () => {
    const body = JSON.stringify({
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Get the weather' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_abc123',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: '{"location": "SF"}',
              },
            },
          ],
        },
      ],
    });

    const result = parseOpenAIStyleRequestBody(body);

    expect(result).toEqual([
      {
        role: 'user',
        index: 0,
        contentBlocks: [{ index: 0, type: 'text' }],
      },
      {
        role: 'assistant',
        index: 1,
        contentBlocks: [
          { index: 0, type: 'tool_call', toolUseId: 'call_abc123', toolName: 'get_weather' },
        ],
      },
    ]);
  });

  it('should parse tool role message (tool result)', () => {
    const body = JSON.stringify({
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Get the weather' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_abc123',
              type: 'function',
              function: { name: 'get_weather', arguments: '{}' },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_abc123',
          content: 'Sunny, 72°F',
        },
      ],
    });

    const result = parseOpenAIStyleRequestBody(body);

    expect(result).toEqual([
      {
        role: 'user',
        index: 0,
        contentBlocks: [{ index: 0, type: 'text' }],
      },
      {
        role: 'assistant',
        index: 1,
        contentBlocks: [
          { index: 0, type: 'tool_call', toolUseId: 'call_abc123', toolName: 'get_weather' },
        ],
      },
      {
        role: 'tool',
        index: 2,
        contentBlocks: [
          { index: 0, type: 'text' },
          { index: 1, type: 'tool_result', toolCallId: 'call_abc123' },
        ],
      },
    ]);
  });

  it('should handle multi-turn conversation', () => {
    const body = JSON.stringify({
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' },
        { role: 'assistant', content: 'I am doing well!' },
      ],
    });

    const result = parseOpenAIStyleRequestBody(body);

    expect(result).toHaveLength(4);
    expect(result?.[0]?.role).toBe('user');
    expect(result?.[0]?.index).toBe(0);
    expect(result?.[1]?.role).toBe('assistant');
    expect(result?.[1]?.index).toBe(1);
    expect(result?.[2]?.role).toBe('user');
    expect(result?.[2]?.index).toBe(2);
    expect(result?.[3]?.role).toBe('assistant');
    expect(result?.[3]?.index).toBe(3);
  });

  it('should handle assistant with both content and tool_calls', () => {
    const body = JSON.stringify({
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Get the weather and tell me about it' },
        {
          role: 'assistant',
          content: 'Let me check the weather for you.',
          tool_calls: [
            {
              id: 'call_xyz789',
              type: 'function',
              function: { name: 'get_weather', arguments: '{}' },
            },
          ],
        },
      ],
    });

    const result = parseOpenAIStyleRequestBody(body);

    expect(result).toEqual([
      {
        role: 'user',
        index: 0,
        contentBlocks: [{ index: 0, type: 'text' }],
      },
      {
        role: 'assistant',
        index: 1,
        contentBlocks: [
          { index: 0, type: 'text' },
          { index: 1, type: 'tool_call', toolUseId: 'call_xyz789', toolName: 'get_weather' },
        ],
      },
    ]);
  });
});
