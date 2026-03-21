import { estimateTokens } from './time';

export interface ParsedMessage {
  index: number;
  role: string;
  content: string;
  contentPreview: string;
  estimatedTokens: number;
  isImage?: boolean;
  isToolCall?: boolean;
  isToolResult?: boolean;
  toolName?: string;
}

export interface MessageBreakdownData {
  messages: ParsedMessage[];
  totalEstimatedTokens: number;
  provider: string;
}

/**
 * Extracts text content from a message content field.
 * Handles various formats:
 * - Simple string
 * - Array of content blocks (Anthropic multimodal: text, image, tool_use, tool_result)
 */
function extractTextFromContent(content: unknown): {
  text: string;
  textForTokenCount: string;
  isImage: boolean;
  isToolCall: boolean;
  isToolResult: boolean;
  toolName?: string;
} {
  if (typeof content === 'string') {
    return {
      text: content,
      textForTokenCount: content,
      isImage: false,
      isToolCall: false,
      isToolResult: false,
    };
  }

  if (Array.isArray(content)) {
    const displayParts: string[] = [];
    const tokenParts: string[] = [];
    let hasImage = false;
    let hasToolCall = false;
    let hasToolResult = false;
    let toolName: string | undefined;

    for (const block of content) {
      if (typeof block === 'string') {
        displayParts.push(block);
        tokenParts.push(block);
        continue;
      }
      if (typeof block !== 'object' || block === null) {
        continue;
      }

      const typedBlock = block as {
        type?: string;
        text?: string;
        name?: string;
        content?: unknown;
        input?: unknown;
      };

      if (typedBlock.type === 'text' && typeof typedBlock.text === 'string') {
        displayParts.push(typedBlock.text);
        tokenParts.push(typedBlock.text);
      } else if (typedBlock.type === 'image' || typedBlock.type === 'image_url') {
        hasImage = true;
        displayParts.push('[Image]');
        // Don't add to tokenParts - images don't count towards text tokens
      } else if (typedBlock.type === 'tool_use') {
        hasToolCall = true;
        toolName = typedBlock.name;
        const toolText = `[Tool: ${typedBlock.name ?? 'unknown'}]`;
        displayParts.push(toolText);
        tokenParts.push(toolText);
        if (typedBlock.input) {
          const inputStr = JSON.stringify(typedBlock.input);
          displayParts.push(inputStr);
          tokenParts.push(inputStr);
        }
      } else if (typedBlock.type === 'tool_result') {
        hasToolResult = true;
        if (typeof typedBlock.content === 'string') {
          displayParts.push(typedBlock.content);
          tokenParts.push(typedBlock.content);
        } else if (typedBlock.content) {
          const contentStr = JSON.stringify(typedBlock.content);
          displayParts.push(contentStr);
          tokenParts.push(contentStr);
        }
      }
    }

    return {
      text: displayParts.join('\n'),
      textForTokenCount: tokenParts.join('\n'),
      isImage: hasImage,
      isToolCall: hasToolCall,
      isToolResult: hasToolResult,
      toolName,
    };
  }

  const jsonStr = JSON.stringify(content);
  return {
    text: jsonStr,
    textForTokenCount: jsonStr,
    isImage: false,
    isToolCall: false,
    isToolResult: false,
  };
}

/**
 * Creates a preview of the content (first 150 chars with ellipsis if truncated)
 */
function createPreview(text: string, maxLength = 150): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

/**
 * Parse messages from an LLM API request body.
 * Supports OpenAI, Anthropic, Groq, and OpenRouter formats.
 */
export function parseMessagesFromBody(
  body: unknown,
  provider: string,
): MessageBreakdownData | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const messages: ParsedMessage[] = [];

  // Handle Anthropic format: system is a separate field
  if (provider === 'anthropic') {
    const anthropicBody = body as {
      system?: string | { type: string; text?: string }[];
      messages?: { role: string; content: unknown }[];
    };

    // Add system message if present
    if (anthropicBody.system) {
      let systemText: string;
      if (typeof anthropicBody.system === 'string') {
        systemText = anthropicBody.system;
      } else if (Array.isArray(anthropicBody.system)) {
        systemText = anthropicBody.system.map((b) => b.text ?? '').join('\n');
      } else {
        systemText = JSON.stringify(anthropicBody.system);
      }

      const tokens = estimateTokens(systemText);
      messages.push({
        index: 0,
        role: 'system',
        content: systemText,
        contentPreview: createPreview(systemText),
        estimatedTokens: tokens,
      });
    }

    // Add messages
    if (anthropicBody.messages && Array.isArray(anthropicBody.messages)) {
      for (const msg of anthropicBody.messages) {
        if (!msg) continue;

        const { text, textForTokenCount, isImage, isToolCall, isToolResult, toolName } =
          extractTextFromContent(msg.content);
        const tokens = estimateTokens(textForTokenCount);

        // Determine display role: Anthropic uses role "user" for tool_result content blocks
        // We want to show these as "tool_result" for clarity
        let displayRole = msg.role;
        if (isToolResult && msg.role === 'user') {
          displayRole = 'tool_result';
        }

        messages.push({
          index: messages.length,
          role: displayRole,
          content: text,
          contentPreview: createPreview(text),
          estimatedTokens: tokens,
          isImage,
          isToolCall,
          isToolResult,
          toolName,
        });
      }
    }
  } else {
    // OpenAI, Groq, OpenRouter format: all messages in messages array
    const openaiBody = body as {
      messages?: { role: string; content: unknown; name?: string; tool_calls?: unknown[] }[];
    };

    if (!openaiBody.messages || !Array.isArray(openaiBody.messages)) {
      return null;
    }

    for (const msg of openaiBody.messages) {
      if (!msg) continue;

      const { text, textForTokenCount, isImage, isToolCall, isToolResult, toolName } =
        extractTextFromContent(msg.content);
      const tokens = estimateTokens(textForTokenCount);

      // Check for tool_calls in the message (OpenAI assistant messages can have tool_calls array)
      const hasToolCalls =
        msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;

      // OpenAI uses role "tool" for tool results, so no role override needed
      messages.push({
        index: messages.length,
        role: msg.role,
        content: text,
        contentPreview: createPreview(text),
        estimatedTokens: tokens,
        isImage,
        isToolCall: isToolCall || hasToolCalls,
        isToolResult: isToolResult || msg.role === 'tool',
        toolName,
      });
    }
  }

  if (messages.length === 0) {
    return null;
  }

  const totalEstimatedTokens = messages.reduce((sum, m) => sum + m.estimatedTokens, 0);

  return {
    messages,
    totalEstimatedTokens,
    provider,
  };
}

/**
 * Parse the response body from an LLM API response.
 * Extracts the assistant's message(s) from OpenAI or Anthropic format.
 */
export function parseResponseBody(body: unknown, provider: string): MessageBreakdownData | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const messages: ParsedMessage[] = [];

  if (provider === 'anthropic') {
    // Anthropic format: { content: [...], role: "assistant", ... }
    const anthropicResponse = body as {
      content?: unknown[];
      role?: string;
      stop_reason?: string;
    };

    if (anthropicResponse.content && Array.isArray(anthropicResponse.content)) {
      const { text, textForTokenCount, isImage, isToolCall, toolName } = extractTextFromContent(
        anthropicResponse.content,
      );
      const tokens = estimateTokens(textForTokenCount);

      messages.push({
        index: 0,
        role: anthropicResponse.role ?? 'assistant',
        content: text,
        contentPreview: createPreview(text),
        estimatedTokens: tokens,
        isImage,
        isToolCall,
        toolName,
      });
    }
  } else {
    // OpenAI format: { choices: [{ message: { role, content }, ... }], ... }
    const openaiResponse = body as {
      choices?: {
        message?: {
          role?: string;
          content?: string | null;
          tool_calls?: { function?: { name?: string; arguments?: string } }[];
        };
        index?: number;
      }[];
    };

    if (openaiResponse.choices && Array.isArray(openaiResponse.choices)) {
      for (const choice of openaiResponse.choices) {
        if (!choice.message) continue;

        const msg = choice.message;
        let content = msg.content ?? '';
        let isToolCall = false;
        let toolName: string | undefined;

        // Handle tool calls in response
        if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
          isToolCall = true;
          const toolParts: string[] = [];
          if (content) toolParts.push(content);

          for (const tc of msg.tool_calls) {
            const name = tc.function?.name ?? 'unknown';
            toolName = toolName ?? name;
            toolParts.push(`[Tool: ${name}]`);
            if (tc.function?.arguments) {
              toolParts.push(tc.function.arguments);
            }
          }
          content = toolParts.join('\n');
        }

        const tokens = estimateTokens(content);

        messages.push({
          index: choice.index ?? messages.length,
          role: msg.role ?? 'assistant',
          content,
          contentPreview: createPreview(content),
          estimatedTokens: tokens,
          isToolCall,
          toolName,
        });
      }
    }
  }

  if (messages.length === 0) {
    return null;
  }

  const totalEstimatedTokens = messages.reduce((sum, m) => sum + m.estimatedTokens, 0);

  return {
    messages,
    totalEstimatedTokens,
    provider,
  };
}
