import type { LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { getProxyHeaders, PROXY_URL } from './config';

export interface ProviderConfig {
  id: string;
  name: string;
  envKey: string;
  basePath: string;
  model: string;
  createModel: (apiKey: string) => LanguageModel;
}

const providers: ProviderConfig[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    basePath: '/openai/v1',
    model: 'gpt-4o-mini',
    createModel: (apiKey) =>
      createOpenAI({
        baseURL: `${PROXY_URL}/openai/v1`,
        apiKey,
        headers: getProxyHeaders(),
      })('gpt-4o-mini'),
  },
  {
    id: 'openai-responses',
    name: 'OpenAI (Responses API)',
    envKey: 'OPENAI_API_KEY',
    basePath: '/openai/v1',
    model: 'gpt-4.1-mini',
    createModel: (apiKey) =>
      createOpenAI({
        baseURL: `${PROXY_URL}/openai/v1`,
        apiKey,
        headers: getProxyHeaders(),
      }).responses('gpt-4.1-mini'),
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    basePath: '/anthropic/v1',
    model: 'claude-haiku-4-5',
    createModel: (apiKey) =>
      createAnthropic({
        baseURL: `${PROXY_URL}/anthropic/v1`,
        apiKey,
        headers: getProxyHeaders(),
      })('claude-haiku-4-5'),
  },
  {
    id: 'google',
    name: 'Google',
    envKey: 'GOOGLE_GENERATIVE_AI_API_KEY',
    basePath: '/google/v1beta',
    model: 'gemini-2.5-flash',
    createModel: (apiKey) =>
      createGoogleGenerativeAI({
        baseURL: `${PROXY_URL}/google/v1beta`,
        apiKey,
        headers: getProxyHeaders(),
      })('gemini-2.5-flash'),
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    envKey: 'OPENROUTER_API_KEY',
    basePath: '/openrouter/v1',
    model: 'google/gemini-2.5-flash-lite',
    createModel: (apiKey) =>
      createOpenRouter({
        baseURL: `${PROXY_URL}/openrouter/v1`,
        apiKey,
        headers: getProxyHeaders(),
      })('google/gemini-2.5-flash-lite'),
  },
  {
    id: 'groq',
    name: 'Groq',
    envKey: 'GROQ_API_KEY',
    basePath: '/groq/v1',
    model: 'openai/gpt-oss-20b',
    createModel: (apiKey) =>
      createGroq({
        baseURL: `${PROXY_URL}/groq/v1`,
        apiKey,
        headers: getProxyHeaders(),
      })('openai/gpt-oss-20b'),
  },
];

export function getProviders(): ProviderConfig[] {
  return providers;
}

export function getProvider(id: string): ProviderConfig | undefined {
  return providers.find((p) => p.id === id);
}

export function getProvidersByIds(ids: string[]): ProviderConfig[] {
  const set = new Set(ids.map((i) => i.toLowerCase()));
  return providers.filter((p) => set.has(p.id));
}

export function getAvailableProviders(): ProviderConfig[] {
  return providers.filter((p) => process.env[p.envKey]);
}

export function createModel(providerId: string, apiKey?: string): LanguageModel | null {
  const config = getProvider(providerId);
  if (!config) return null;
  const key = apiKey ?? process.env[config.envKey];
  if (!key) return null;
  return config.createModel(key);
}
