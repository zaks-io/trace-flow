import { streamText, stepCountIs, tool } from 'ai';
import { createGroq } from '@ai-sdk/groq';
import { z } from 'zod';
import { PROXY_URL, proxyHeaders, requireEnv, log, success, error } from './config';

const apiKey = requireEnv('GROQ_API_KEY');

const groq = createGroq({
  baseURL: `${PROXY_URL}/groq/v1`,
  apiKey,
  headers: proxyHeaders,
});

const model = groq('openai/gpt-oss-120b');

function generateTraceId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function generateSpanId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function testToolCall() {
  log('Groq Tools', 'Testing tool call...');
  const start = Date.now();

  try {
    // Generate once per user request
    const traceId = generateTraceId();
    const spanId = generateSpanId();

    const result = await streamText({
      model,
      system:
        'You are a helpful assistant. When asked for the current time, use the getCurrentTime tool and return the result.',
      prompt: 'What is the current time?',
      tools: {
        getCurrentTime: tool({
          description: 'Get the current time',
          inputSchema: z.object({}),
          execute: async ({}) => new Date().toISOString(),
        }),
      },
      stopWhen: stepCountIs(2),
      headers: { traceparent: `00-${traceId}-${spanId}-01` },
    });
    const text = await result.text;
    const steps = await result.steps;
    const duration = Date.now() - start;
    success('Groq Tools', `Response (${duration}ms): "${text.trim()}"`);
    console.log(`  Tool calls: ${steps.flatMap((s) => s.toolCalls).length}`);
    return true;
  } catch (e: unknown) {
    error('Groq Tools', `Tool call failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function main() {
  console.log('='.repeat(50));
  console.log('Groq Tools Test');
  console.log(`Proxy URL: ${PROXY_URL}/groq/v1`);
  console.log('='.repeat(50));

  const passed = await testToolCall();

  console.log(`\n${passed ? '✓ All tests passed' : '✗ Some tests failed'}`);
  process.exit(passed ? 0 : 1);
}

void main();
