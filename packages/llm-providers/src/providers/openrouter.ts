import { PROVIDER_SCHEMAS } from '../schemas';
import { parseDecisionMetadata, parseDecisionTokenUsage } from './decision';
import {
  aggregateOpenAIStyleSSETokens,
  findOpenAIStyleStreamFailure,
  handleOpenAIStyleSSEEvent,
  parseOpenAIStyleRequestBody,
  parseOpenAIStyleResponseMetadata,
  parseOpenAIStyleResponseTokenUsage,
} from './openai-style';
import type { Provider } from './types';

/**
 * OpenRouter shares the OpenAI streaming shape but additionally carries an
 * upstream `cost` field inside usage. `includeCost: true` is the only delta
 * from `openai`/`groq`.
 */
export const openrouter: Provider = {
  id: 'openrouter',
  baseUrl: 'https://openrouter.ai/api',
  tokenSchema: PROVIDER_SCHEMAS.openrouter,

  parseRequestBody: parseOpenAIStyleRequestBody,
  parseResponseMetadata: (body, ctx) =>
    ctx?.operationName === 'decision'
      ? parseDecisionMetadata(body)
      : parseOpenAIStyleResponseMetadata(body),
  parseResponseTokenUsage: (body, ctx) =>
    ctx?.operationName === 'decision'
      ? parseDecisionTokenUsage(body, true)
      : parseOpenAIStyleResponseTokenUsage(body, 'openrouter'),

  handleSSEEvent: (event, timestamp, state) =>
    handleOpenAIStyleSSEEvent(event, timestamp, state, { includeCost: true }),
  aggregateSSETokens: (state) => aggregateOpenAIStyleSSETokens(state, 'openrouter'),
  findStreamFailure: findOpenAIStyleStreamFailure,
};
