import type { InputMessage, InputContentBlock } from '@trace-flow/types';

/**
 * OpenAI-style request body structure (used by OpenAI, Groq, OpenRouter).
 */
interface OpenAIStyleRequestBody {
  model?: string;
  messages?: {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content?: string | null;
    tool_calls?: {
      id: string;
      type: 'function';
      function: {
        name: string;
        arguments: string;
      };
    }[];
    tool_call_id?: string;
  }[];
}

/**
 * Parses an OpenAI-style request body to extract input messages.
 * Works with OpenAI, Groq, and OpenRouter APIs.
 * Returns null if the body is not a valid OpenAI-style messages API request.
 */
export function parseOpenAIStyleRequestBody(body: string): InputMessage[] | null {
  try {
    const parsed = JSON.parse(body) as OpenAIStyleRequestBody;

    if (!parsed.messages || !Array.isArray(parsed.messages)) {
      return null;
    }

    const inputMessages: InputMessage[] = [];

    for (let messageIndex = 0; messageIndex < parsed.messages.length; messageIndex++) {
      const msg = parsed.messages[messageIndex];
      if (!msg) continue;

      const contentBlocks: InputContentBlock[] = [];

      // Text content (if present)
      if (msg.content) {
        contentBlocks.push({
          index: 0,
          type: 'text',
        });
      }

      // Tool calls in assistant message (OpenAI-style)
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const toolCall of msg.tool_calls) {
          if (!toolCall) continue;

          contentBlocks.push({
            index: contentBlocks.length,
            type: 'tool_call',
            toolUseId: toolCall.id,
            toolName: toolCall.function?.name,
          });
        }
      }

      // Tool result message (role: 'tool')
      if (msg.role === 'tool' && msg.tool_call_id) {
        contentBlocks.push({
          index: contentBlocks.length,
          type: 'tool_result',
          toolCallId: msg.tool_call_id,
        });
      }

      // Only add message if it has content blocks
      if (contentBlocks.length > 0) {
        inputMessages.push({
          role: msg.role,
          index: messageIndex,
          contentBlocks,
        });
      }
    }

    return inputMessages.length > 0 ? inputMessages : null;
  } catch {
    return null;
  }
}

/**
 * Anthropic request body structure for messages API.
 */
interface AnthropicRequestBody {
  model?: string;
  messages?: {
    role: 'user' | 'assistant';
    content:
      | string
      | {
          type: 'text' | 'tool_use' | 'tool_result' | 'image';
          text?: string;
          id?: string;
          name?: string;
          input?: unknown;
          tool_use_id?: string;
          content?: string | { type: string; text?: string }[];
          source?: unknown;
        }[];
  }[];
  system?: string | { type: 'text'; text: string }[];
}

/**
 * Parses an Anthropic request body to extract input messages.
 * Returns null if the body is not a valid Anthropic messages API request.
 *
 * This extracts the structure of messages without storing content,
 * suitable for creating input spans that show message flow.
 */
export function parseAnthropicRequestBody(body: string): InputMessage[] | null {
  try {
    const parsed = JSON.parse(body) as AnthropicRequestBody;

    // Must have messages array to be a valid Anthropic request
    if (!parsed.messages || !Array.isArray(parsed.messages)) {
      return null;
    }

    const inputMessages: InputMessage[] = [];
    let messageIndex = 0;

    // Handle system message if present
    if (parsed.system) {
      inputMessages.push({
        role: 'system',
        index: messageIndex++,
        contentBlocks: [
          {
            index: 0,
            type: 'text',
          },
        ],
      });
    }

    // Parse each message
    for (const msg of parsed.messages) {
      const contentBlocks: InputContentBlock[] = [];

      if (typeof msg.content === 'string') {
        // Simple string content - treat as single text block
        contentBlocks.push({
          index: 0,
          type: 'text',
        });
      } else if (Array.isArray(msg.content)) {
        // Array of content blocks
        for (let blockIndex = 0; blockIndex < msg.content.length; blockIndex++) {
          const block = msg.content[blockIndex];
          if (!block) continue;

          const inputBlock: InputContentBlock = {
            index: blockIndex,
            type: block.type,
          };

          if (block.type === 'tool_use') {
            inputBlock.toolUseId = block.id;
            inputBlock.toolName = block.name;
          } else if (block.type === 'tool_result') {
            inputBlock.toolResultId = block.tool_use_id;
          }

          contentBlocks.push(inputBlock);
        }
      }

      inputMessages.push({
        role: msg.role,
        index: messageIndex++,
        contentBlocks,
      });
    }

    return inputMessages;
  } catch (error) {
    console.warn('Error parsing Anthropic request body:', error);
    // Invalid JSON or unexpected structure
    return null;
  }
}

/**
 * Extracts tool_result references from input messages.
 * Returns an array of tool_use_ids that have corresponding tool_results in this request.
 */
export function extractToolResultIds(inputMessages: InputMessage[]): string[] {
  const toolResultIds: string[] = [];

  for (const message of inputMessages) {
    for (const block of message.contentBlocks) {
      if (block.type === 'tool_result' && block.toolResultId) {
        toolResultIds.push(block.toolResultId);
      }
    }
  }

  return toolResultIds;
}

/**
 * Extracts tool_use blocks from SSE content blocks.
 * Returns tool_use info for storing in the ToolCallTracker.
 */
export function extractToolUseFromContentBlocks(
  contentBlocks: {
    type: string;
    toolUseId?: string;
    toolName?: string;
    stopTimestamp?: number;
  }[],
): { toolUseId: string; toolName: string; stopTimestamp: number }[] {
  const toolUses: { toolUseId: string; toolName: string; stopTimestamp: number }[] = [];

  for (const block of contentBlocks) {
    if (block.type === 'tool_use' && block.toolUseId && block.toolName && block.stopTimestamp) {
      toolUses.push({
        toolUseId: block.toolUseId,
        toolName: block.toolName,
        stopTimestamp: block.stopTimestamp,
      });
    }
  }

  return toolUses;
}

/**
 * Google request body structure for Gemini API.
 */
interface GoogleRequestBody {
  contents?: {
    role?: 'user' | 'model';
    parts: {
      text?: string;
      inlineData?: unknown;
      functionCall?: { name: string; args: unknown };
      functionResponse?: { name: string; response: unknown };
    }[];
  }[];
  systemInstruction?: {
    parts: { text: string }[];
  };
  tools?: unknown[];
}

/**
 * Parses a Google Gemini request body to extract input messages.
 * Google uses 'contents' array with 'user'/'model' roles and 'parts' for content.
 * Returns null if the body is not a valid Google messages API request.
 */
export function parseGoogleRequestBody(body: string): InputMessage[] | null {
  try {
    const parsed = JSON.parse(body) as GoogleRequestBody;

    // Must have contents array to be a valid Google request
    if (!parsed.contents || !Array.isArray(parsed.contents)) {
      return null;
    }

    const inputMessages: InputMessage[] = [];
    let messageIndex = 0;

    // Handle system instruction if present
    if (parsed.systemInstruction?.parts) {
      inputMessages.push({
        role: 'system',
        index: messageIndex++,
        contentBlocks: [{ index: 0, type: 'text' }],
      });
    }

    // Parse each content entry
    for (const content of parsed.contents) {
      const contentBlocks: InputContentBlock[] = [];

      // Map Google roles to standard roles ('model' -> 'assistant')
      const role = content.role === 'model' ? 'assistant' : 'user';

      for (let partIndex = 0; partIndex < content.parts.length; partIndex++) {
        const part = content.parts[partIndex];
        if (!part) continue;

        if (part.text !== undefined) {
          contentBlocks.push({ index: partIndex, type: 'text' });
        } else if (part.inlineData) {
          contentBlocks.push({ index: partIndex, type: 'image' });
        } else if (part.functionCall) {
          contentBlocks.push({
            index: partIndex,
            type: 'tool_call',
            toolName: part.functionCall.name,
          });
        } else if (part.functionResponse) {
          contentBlocks.push({
            index: partIndex,
            type: 'tool_result',
            toolResultId: part.functionResponse.name,
          });
        }
      }

      if (contentBlocks.length > 0) {
        inputMessages.push({
          role,
          index: messageIndex++,
          contentBlocks,
        });
      }
    }

    return inputMessages.length > 0 ? inputMessages : null;
  } catch {
    return null;
  }
}
