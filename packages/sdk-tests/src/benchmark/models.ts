import type { LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { PROXY_URL, getProxyHeaders } from '../config';

export interface BenchmarkProvider {
  id: string;
  name: string;
  model: string;
  envKey: string;
  createProxiedModel: () => LanguageModel;
  createDirectModel: () => LanguageModel;
}

interface ProviderDef {
  id: string;
  name: string;
  model: string;
  envKey: string;
  createProxied: (apiKey: string) => LanguageModel;
  createDirect: (apiKey: string) => LanguageModel;
}

const defs: ProviderDef[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    model: 'gpt-4o-mini',
    envKey: 'OPENAI_API_KEY',

    createProxied: (apiKey) =>
      createOpenAI({ baseURL: `${PROXY_URL}/openai/v1`, apiKey, headers: getProxyHeaders() })(
        'gpt-4o-mini',
      ),
    createDirect: (apiKey) => createOpenAI({ apiKey })('gpt-4o-mini'),
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    model: 'claude-haiku-4-5',
    envKey: 'ANTHROPIC_API_KEY',

    createProxied: (apiKey) =>
      createAnthropic({
        baseURL: `${PROXY_URL}/anthropic/v1`,
        apiKey,
        headers: getProxyHeaders(),
      })('claude-haiku-4-5'),
    createDirect: (apiKey) => createAnthropic({ apiKey })('claude-haiku-4-5'),
  },
  {
    id: 'google',
    name: 'Google',
    model: 'gemini-2.5-flash',
    envKey: 'GOOGLE_GENERATIVE_AI_API_KEY',

    createProxied: (apiKey) =>
      createGoogleGenerativeAI({
        baseURL: `${PROXY_URL}/google/v1beta`,
        apiKey,
        headers: getProxyHeaders(),
      })('gemini-2.5-flash'),
    createDirect: (apiKey) => createGoogleGenerativeAI({ apiKey })('gemini-2.5-flash'),
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    model: 'google/gemini-2.5-flash-lite',
    envKey: 'OPENROUTER_API_KEY',

    createProxied: (apiKey) =>
      createOpenRouter({
        baseURL: `${PROXY_URL}/openrouter/v1`,
        apiKey,
        headers: getProxyHeaders(),
      })('google/gemini-2.5-flash-lite'),
    createDirect: (apiKey) => createOpenRouter({ apiKey })('google/gemini-2.5-flash-lite'),
  },
  {
    id: 'groq',
    name: 'Groq',
    model: 'openai/gpt-oss-20b',
    envKey: 'GROQ_API_KEY',

    createProxied: (apiKey) =>
      createGroq({ baseURL: `${PROXY_URL}/groq/v1`, apiKey, headers: getProxyHeaders() })(
        'openai/gpt-oss-20b',
      ),
    createDirect: (apiKey) => createGroq({ apiKey })('openai/gpt-oss-20b'),
  },
];

export function getBenchmarkProvider(id: string): BenchmarkProvider | null {
  const def = defs.find((d) => d.id === id);
  if (!def) return null;
  const apiKey = process.env[def.envKey];
  if (!apiKey) return null;
  return {
    id: def.id,
    name: def.name,
    model: def.model,
    envKey: def.envKey,
    createProxiedModel: () => def.createProxied(apiKey),
    createDirectModel: () => def.createDirect(apiKey),
  };
}

export function getAvailableBenchmarkProviderIds(): string[] {
  return defs.filter((d) => process.env[d.envKey]).map((d) => d.id);
}

export function getAllAvailableBenchmarkProviders(): BenchmarkProvider[] {
  return getAvailableBenchmarkProviderIds()
    .map((id) => getBenchmarkProvider(id))
    .filter((bp): bp is BenchmarkProvider => bp != null);
}
