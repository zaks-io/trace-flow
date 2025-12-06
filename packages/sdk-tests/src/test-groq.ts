import { generateText, streamText } from 'ai';
import { createGroq } from '@ai-sdk/groq';
import { PROXY_URL, proxyHeaders, requireEnv, log, success, error } from './config';

const apiKey = requireEnv('GROQ_API_KEY');

// Groq uses OpenAI-compatible API
// Their baseURL is https://api.groq.com/openai/v1
const groq = createGroq({
  baseURL: `${PROXY_URL}/groq/v1`,
  apiKey,
  headers: proxyHeaders,
});

const model = groq('llama-3.1-8b-instant');

async function testNonStreaming() {
  log('Groq', 'Testing non-streaming...');
  const start = Date.now();

  try {
    const result = await generateText({
      model,
      prompt: 'Say "Hello from the proxy!" in exactly 5 words.',
      maxOutputTokens: 50,
    });

    const duration = Date.now() - start;
    success('Groq', `Response (${duration}ms): "${result.text.trim()}"`);
    console.log(
      `  Tokens: ${result.usage.inputTokens} prompt, ${result.usage.outputTokens} completion`,
    );
    return true;
  } catch (e: unknown) {
    error('Groq', `Non-streaming failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function testStreaming() {
  log('Groq', 'Testing streaming...');
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
    success('Groq', `Stream complete (${duration}ms, TTFT: ${firstTokenTime}ms)`);
    console.log(`  Tokens: ${usage.inputTokens} prompt, ${usage.outputTokens} completion`);
    return true;
  } catch (e: unknown) {
    error('Groq', `Streaming failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function main() {
  console.log('='.repeat(50));
  console.log('Groq Proxy Test');
  console.log(`Proxy URL: ${PROXY_URL}/groq/v1`);
  console.log('='.repeat(50));

  const results = await Promise.all([testNonStreaming(), testStreaming()]);
  const passed = results.every(Boolean);

  console.log(`\n${passed ? '✓ All tests passed' : '✗ Some tests failed'}`);
  process.exit(passed ? 0 : 1);
}

void main();
