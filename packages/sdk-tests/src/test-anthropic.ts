import { generateText, streamText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { PROXY_URL, proxyHeaders, requireEnv, log, success, error } from './config';

const apiKey = requireEnv('ANTHROPIC_API_KEY');

// Anthropic SDK's default baseURL is https://api.anthropic.com/v1
// so we need /anthropic/v1 to match their API structure
const anthropic = createAnthropic({
  baseURL: `${PROXY_URL}/anthropic/v1`,
  apiKey,
  headers: proxyHeaders,
});

const model = anthropic('claude-haiku-4-5');

async function testNonStreaming() {
  log('Anthropic', 'Testing non-streaming...');
  const start = Date.now();

  try {
    const result = await generateText({
      model,
      prompt: 'Say "Hello from the proxy!" in exactly 5 words.',
      maxOutputTokens: 50,
    });

    const duration = Date.now() - start;
    success('Anthropic', `Response (${duration}ms): "${result.text.trim()}"`);
    console.log(
      `  Tokens: ${result.usage.inputTokens} prompt, ${result.usage.outputTokens} completion`,
    );
    return true;
  } catch (e: unknown) {
    error('Anthropic', `Non-streaming failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function testStreaming() {
  log('Anthropic', 'Testing streaming...');
  const start = Date.now();

  try {
    const result = streamText({
      model,
      prompt: 'Count from 1 to 5, one number per line.',
      maxOutputTokens: 50,
    });

    let firstTokenTime: number | null = null;
    process.stdout.write('  ');

    for await (const chunk of result.textStream) {
      firstTokenTime ??= Date.now() - start;
      process.stdout.write(chunk);
    }
    console.log();

    const duration = Date.now() - start;
    const usage = await result.usage;
    success('Anthropic', `Stream complete (${duration}ms, TTFT: ${firstTokenTime}ms)`);
    console.log(`  Tokens: ${usage.inputTokens} prompt, ${usage.outputTokens} completion`);
    return true;
  } catch (e: unknown) {
    error('Anthropic', `Streaming failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function main() {
  console.log('='.repeat(50));
  console.log('Anthropic Proxy Test');
  console.log(`Proxy URL: ${PROXY_URL}/anthropic/v1`);
  console.log('='.repeat(50));

  const results = await Promise.all([testNonStreaming(), testStreaming()]);
  const passed = results.every(Boolean);

  console.log(`\n${passed ? '✓ All tests passed' : '✗ Some tests failed'}`);
  process.exit(passed ? 0 : 1);
}

void main();
