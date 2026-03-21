export function extractProviderFromUrl(url: string): string {
  try {
    const hostname = new URL(url).hostname.toLowerCase();

    if (hostname.includes('openai.com')) return 'openai';
    if (hostname.includes('anthropic.com')) return 'anthropic';
    if (hostname.includes('openrouter.ai')) return 'openrouter';
    if (hostname.includes('groq.com')) return 'groq';
    if (hostname.includes('generativelanguage.googleapis.com')) return 'google';
    if (hostname.includes('api.mistral.ai')) return 'mistral';
    if (hostname.includes('api.cohere.ai')) return 'cohere';
    if (hostname.includes('api.perplexity.ai')) return 'perplexity';

    return hostname;
  } catch {
    return 'unknown';
  }
}

/**
 * Derives the gen_ai.operation.name from the API endpoint path.
 * Per OpenTelemetry GenAI semantic conventions:
 * https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/
 */
export function deriveOperationName(path: string): string {
  const normalizedPath = path.toLowerCase();

  // OpenAI / Groq / OpenRouter patterns
  if (normalizedPath.includes('/chat/completions')) return 'chat';
  if (normalizedPath.includes('/completions') && !normalizedPath.includes('/chat/'))
    return 'text_completion';
  if (normalizedPath.includes('/embeddings')) return 'embeddings';

  // Anthropic patterns
  if (normalizedPath.includes('/messages')) return 'chat';

  // Google Gemini patterns
  if (normalizedPath.includes(':generatecontent')) return 'chat';
  if (normalizedPath.includes(':embedcontent')) return 'embeddings';

  return 'chat';
}
