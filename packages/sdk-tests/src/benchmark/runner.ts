import type { LanguageModel } from 'ai';

export interface TimingResult {
  duration: number;
  ttft?: number;
  outputTokens?: number;
  success: boolean;
  error?: string;
}

export async function measureNonStreaming(
  model: LanguageModel,
  prompt: string,
  maxTokens: number,
): Promise<TimingResult> {
  const { generateText } = await import('ai');
  const start = Date.now();
  try {
    const result = await generateText({ model, prompt, maxOutputTokens: maxTokens });
    return {
      duration: Date.now() - start,
      outputTokens: result.usage?.outputTokens,
      success: true,
    };
  } catch (e: unknown) {
    return {
      duration: Date.now() - start,
      success: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function measureStreaming(
  model: LanguageModel,
  prompt: string,
  maxTokens: number,
): Promise<TimingResult> {
  const { streamText } = await import('ai');
  const start = Date.now();
  let ttft: number | undefined;
  try {
    const result = streamText({ model, prompt, maxOutputTokens: maxTokens });
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta' || part.type === 'reasoning-delta') {
        ttft ??= Date.now() - start;
      }
    }
    const usage = await result.usage;
    return {
      duration: Date.now() - start,
      ttft,
      outputTokens: usage?.outputTokens,
      success: true,
    };
  } catch (e: unknown) {
    return {
      duration: Date.now() - start,
      ttft,
      success: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
