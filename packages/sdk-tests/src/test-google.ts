import { generateText, streamText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { PROXY_URL, proxyHeaders, requireEnv, log, success, error } from './config';

const apiKey = requireEnv('GOOGLE_GENERATIVE_AI_API_KEY');

const google = createGoogleGenerativeAI({
  baseURL: `${PROXY_URL}/google/v1beta`,
  apiKey,
  headers: proxyHeaders,
});

const model = google('gemini-2.0-flash');

async function testNonStreaming() {
  log('Google', 'Testing non-streaming...');
  const start = Date.now();

  try {
    const result = await generateText({
      model,
      prompt: 'Say "Hello from the proxy!" in exactly 5 words.',
      maxOutputTokens: 50,
    });

    const duration = Date.now() - start;
    success('Google', `Response (${duration}ms): "${result.text.trim()}"`);
    console.log(
      `  Tokens: ${result.usage.inputTokens} prompt, ${result.usage.outputTokens} completion`,
    );
    return true;
  } catch (e: unknown) {
    error('Google', `Non-streaming failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function testStreaming() {
  log('Google', 'Testing streaming...');
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
    success('Google', `Stream complete (${duration}ms, TTFT: ${firstTokenTime}ms)`);
    console.log(`  Tokens: ${usage.inputTokens} prompt, ${usage.outputTokens} completion`);
    return true;
  } catch (e: unknown) {
    error('Google', `Streaming failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function main() {
  console.log('='.repeat(50));
  console.log('Google Gemini Proxy Test');
  console.log(`Proxy URL: ${PROXY_URL}/google/v1beta`);
  console.log('='.repeat(50));

  const results = await Promise.all([testNonStreaming(), testStreaming()]);
  const passed = results.every(Boolean);

  console.log(`\n${passed ? '✓ All tests passed' : '✗ Some tests failed'}`);
  process.exit(passed ? 0 : 1);
}

void main();
