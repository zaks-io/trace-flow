import { PROVIDER_SCHEMAS } from '../schemas';
import {
  aggregateOpenAIStyleSSETokens,
  handleOpenAIStyleSSEEvent,
  parseOpenAIStyleRequestBody,
  parseOpenAIStyleResponseMetadata,
  parseOpenAIStyleResponseTokenUsage,
} from './openai-style';
import type { Provider } from './types';

export const groq: Provider = {
  id: 'groq',
  baseUrl: 'https://api.groq.com/openai',
  tokenSchema: PROVIDER_SCHEMAS.groq,

  parseRequestBody: parseOpenAIStyleRequestBody,
  parseResponseMetadata: parseOpenAIStyleResponseMetadata,
  parseResponseTokenUsage: (body) => parseOpenAIStyleResponseTokenUsage(body, 'groq'),

  handleSSEEvent: (event, timestamp, state) => handleOpenAIStyleSSEEvent(event, timestamp, state),
  aggregateSSETokens: (state) => aggregateOpenAIStyleSSETokens(state, 'groq'),
};
