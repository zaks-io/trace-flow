import type { ProviderId, ProviderTokenSchema } from './types';

export const PROVIDER_SCHEMAS: Record<ProviderId, ProviderTokenSchema> = {
  openai: {
    promptFields: ['prompt_tokens', 'input_tokens'],
    completionFields: ['completion_tokens', 'output_tokens'],
    totalFields: ['total_tokens'],
    cacheReadFields: ['cached_tokens'],
    reasoningFields: ['reasoning_tokens'],
    promptIncludesCache: true,
    lastMatchOnly: false,
  },
  anthropic: {
    promptFields: ['input_tokens'],
    completionFields: ['output_tokens'],
    cacheReadFields: ['cache_read_input_tokens'],
    cacheCreationFields: ['cache_creation_input_tokens'],
    promptIncludesCache: false,
    lastMatchOnly: false,
    nestedCacheCreation: {
      field5m: 'ephemeral_5m_input_tokens',
      field1h: 'ephemeral_1h_input_tokens',
    },
  },
  google: {
    promptFields: ['promptTokenCount'],
    completionFields: ['candidatesTokenCount'],
    totalFields: ['totalTokenCount'],
    cacheReadFields: ['cachedContentTokenCount'],
    reasoningFields: ['thoughtsTokenCount'],
    promptIncludesCache: true,
    lastMatchOnly: true,
  },
  openrouter: {
    promptFields: ['prompt_tokens', 'input_tokens'],
    completionFields: ['completion_tokens', 'output_tokens'],
    totalFields: ['total_tokens'],
    cacheReadFields: ['cached_tokens'],
    cacheCreationFields: ['cache_write_tokens'],
    reasoningFields: ['reasoning_tokens'],
    hasUpstreamCost: true,
    promptIncludesCache: true,
    lastMatchOnly: false,
  },
  groq: {
    promptFields: ['prompt_tokens'],
    completionFields: ['completion_tokens'],
    totalFields: ['total_tokens'],
    reasoningFields: ['reasoning_tokens'],
    promptIncludesCache: true,
    lastMatchOnly: false,
  },
};
