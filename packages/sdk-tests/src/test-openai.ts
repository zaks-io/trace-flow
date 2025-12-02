import { generateText, streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { PROXY_URL, proxyHeaders, requireEnv, log, success, error } from './config';

const apiKey = requireEnv('OPENAI_API_KEY');

// OpenAI SDK's default baseURL is https://api.openai.com/v1
// so we need /openai/v1 to match their API structure
const openai = createOpenAI({
  baseURL: `${PROXY_URL}/openai/v1`,
  apiKey,
  headers: proxyHeaders,
});

const model = openai('gpt-4o-mini');

async function testNonStreaming() {
  log('OpenAI', 'Testing non-streaming...');
  const start = Date.now();

  try {
    const result = await generateText({
      model,
      prompt: 'Say "Hello from the proxy!" in exactly 5 words.',
      maxOutputTokens: 50,
    });

    const duration = Date.now() - start;
    success('OpenAI', `Response (${duration}ms): "${result.text.trim()}"`);
    console.log(
      `  Tokens: ${result.usage.inputTokens} prompt, ${result.usage.outputTokens} completion`,
    );
    return true;
  } catch (e: unknown) {
    error('OpenAI', `Non-streaming failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function testStreaming() {
  log('OpenAI', 'Testing streaming...');
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
    success('OpenAI', `Stream complete (${duration}ms, TTFT: ${firstTokenTime}ms)`);
    console.log(`  Tokens: ${usage.inputTokens} prompt, ${usage.outputTokens} completion`);
    return true;
  } catch (e: unknown) {
    error('OpenAI', `Streaming failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function main() {
  console.log('='.repeat(50));
  console.log('OpenAI Proxy Test');
  console.log(`Proxy URL: ${PROXY_URL}/openai/v1`);
  console.log('='.repeat(50));

  const results = await Promise.all([testNonStreaming(), testStreaming()]);
  const passed = results.every(Boolean);

  console.log(`\n${passed ? '✓ All tests passed' : '✗ Some tests failed'}`);
  process.exit(passed ? 0 : 1);
}

void main();
