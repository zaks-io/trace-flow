import { generateText, streamText, type LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { PROXY_URL, proxyHeaders, log, success, error } from './config';

interface ProviderConfig {
  name: string;
  envKey: string;
  createProvider: (apiKey: string) => (model: string) => LanguageModel;
  model: string;
}

const providers: ProviderConfig[] = [
  {
    name: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    createProvider: (apiKey) =>
      createOpenAI({ baseURL: `${PROXY_URL}/openai/v1`, apiKey, headers: proxyHeaders }),
    model: 'gpt-4o-mini',
  },
  {
    name: 'Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    createProvider: (apiKey) =>
      createAnthropic({ baseURL: `${PROXY_URL}/anthropic/v1`, apiKey, headers: proxyHeaders }),
    model: 'claude-haiku-4-5',
  },
  {
    name: 'Google',
    envKey: 'GOOGLE_GENERATIVE_AI_API_KEY',
    createProvider: (apiKey) =>
      createGoogleGenerativeAI({
        baseURL: `${PROXY_URL}/google/v1beta`,
        apiKey,
        headers: proxyHeaders,
      }),
    model: 'gemini-2.0-flash',
  },
  {
    name: 'OpenRouter',
    envKey: 'OPENROUTER_API_KEY',
    createProvider: (apiKey) =>
      createOpenAI({ baseURL: `${PROXY_URL}/openrouter/v1`, apiKey, headers: proxyHeaders }),
    model: 'openai/gpt-4o-mini',
  },
  {
    name: 'Groq',
    envKey: 'GROQ_API_KEY',
    createProvider: (apiKey) =>
      createOpenAI({ baseURL: `${PROXY_URL}/groq/v1`, apiKey, headers: proxyHeaders }),
    model: 'llama-3.1-8b-instant',
  },
];

async function testProvider(config: ProviderConfig): Promise<{ name: string; passed: boolean }> {
  const apiKey = process.env[config.envKey];
  if (!apiKey) {
    log(config.name, `Skipped (${config.envKey} not set)`);
    return { name: config.name, passed: true };
  }

  const provider = config.createProvider(apiKey);
  const model = provider(config.model);
  let passed = true;

  // Non-streaming test
  try {
    log(config.name, 'Testing non-streaming...');
    const start = Date.now();
    const result = await generateText({
      model,
      prompt: 'Say hello in 3 words.',
      maxOutputTokens: 20,
    });
    success(config.name, `Non-streaming OK (${Date.now() - start}ms): "${result.text.trim()}"`);
  } catch (e: unknown) {
    error(config.name, `Non-streaming failed: ${e instanceof Error ? e.message : String(e)}`);
    passed = false;
  }

  // Streaming test
  try {
    log(config.name, 'Testing streaming...');
    const start = Date.now();
    const result = streamText({
      model,
      prompt: 'Count to 3.',
      maxOutputTokens: 20,
    });

    let text = '';
    for await (const chunk of result.textStream) {
      text += chunk;
    }
    success(config.name, `Streaming OK (${Date.now() - start}ms): "${text.trim()}"`);
  } catch (e: unknown) {
    error(config.name, `Streaming failed: ${e instanceof Error ? e.message : String(e)}`);
    passed = false;
  }

  return { name: config.name, passed };
}

async function main() {
  console.log('='.repeat(60));
  console.log('AI SDK Proxy Integration Tests');
  console.log(`Proxy URL: ${PROXY_URL}`);
  console.log('='.repeat(60));

  const results = await Promise.all(providers.map(testProvider));

  console.log(`\n${'='.repeat(60)}`);
  console.log('Summary:');
  console.log('='.repeat(60));

  for (const { name, passed } of results) {
    console.log(`  ${name.padEnd(12)} ${passed ? '✓ PASS' : '✗ FAIL'}`);
  }

  const allPassed = results.every((r) => r.passed);
  process.exit(allPassed ? 0 : 1);
}

void main();
