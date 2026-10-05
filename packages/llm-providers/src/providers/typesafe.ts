import { PROVIDER_SCHEMAS } from '../schemas';
import { parseDecisionMetadata, parseDecisionTokenUsage } from './decision';
import type { Provider } from './types';

export const typesafe: Provider = {
  id: 'typesafe',
  baseUrl: 'https://api.typesafe.ai',
  tokenSchema: PROVIDER_SCHEMAS.typesafe,
  parseRequestBody: () => null,
  parseResponseMetadata: parseDecisionMetadata,
  parseResponseTokenUsage: (body) => parseDecisionTokenUsage(body),
  // TypeSafe documents JSON responses only. Do not infer a streaming protocol.
  handleSSEEvent: () => undefined,
  aggregateSSETokens: () => undefined,
  findStreamFailure: () => undefined,
};
