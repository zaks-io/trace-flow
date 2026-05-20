import { PROVIDER_SCHEMAS } from '../schemas';
import {
  aggregateOpenAIStyleSSETokens,
  handleOpenAIStyleSSEEvent,
  parseOpenAIStyleRequestBody,
  parseOpenAIStyleResponseMetadata,
  parseOpenAIStyleResponseTokenUsage,
} from './openai-style';
import type { Provider } from './types';

export const openai: Provider = {
  id: 'openai',
  baseUrl: 'https://api.openai.com',
  tokenSchema: PROVIDER_SCHEMAS.openai,

  parseRequestBody: parseOpenAIStyleRequestBody,
  parseResponseMetadata: parseOpenAIStyleResponseMetadata,
  parseResponseTokenUsage: (body) => parseOpenAIStyleResponseTokenUsage(body, 'openai'),

  handleSSEEvent: (event, timestamp, state) => handleOpenAIStyleSSEEvent(event, timestamp, state),
  aggregateSSETokens: (state) => aggregateOpenAIStyleSSETokens(state, 'openai'),
};
