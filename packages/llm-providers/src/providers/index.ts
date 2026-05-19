import type { ProviderId } from '../types';
import { anthropic } from './anthropic';
import { google } from './google';
import { groq } from './groq';
import { openai } from './openai';
import { openrouter } from './openrouter';
import type { Provider } from './types';

export const PROVIDERS: Record<ProviderId, Provider> = {
  openai,
  anthropic,
  google,
  openrouter,
  groq,
};

export function getProvider(id: ProviderId): Provider {
  return PROVIDERS[id];
}

export type { Provider, ParsedSSEEvent } from './types';
