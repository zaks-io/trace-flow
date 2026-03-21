export interface DefaultPricing {
  provider: string;
  model: string;
  promptCostPerMillion: number; // microdollars per million tokens
  completionCostPerMillion: number; // microdollars per million tokens
  cacheReadCostPerMillion?: number;
  cacheWriteCostPerMillion?: number;
  cacheWrite1hCostPerMillion?: number;
}

export const DEFAULT_PRICING: DefaultPricing[] = [
  // Anthropic models - using prefixes (without date suffixes) for automatic matching
  // Claude 4.6 series
  {
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    promptCostPerMillion: 5_000_000,
    completionCostPerMillion: 25_000_000,
    cacheWriteCostPerMillion: 6_250_000,
    cacheWrite1hCostPerMillion: 10_000_000,
    cacheReadCostPerMillion: 500_000,
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    promptCostPerMillion: 3_000_000,
    completionCostPerMillion: 15_000_000,
    cacheWriteCostPerMillion: 3_750_000,
    cacheWrite1hCostPerMillion: 6_000_000,
    cacheReadCostPerMillion: 300_000,
  },
  // Claude 4.5 series
  {
    provider: 'anthropic',
    model: 'claude-opus-4-5',
    promptCostPerMillion: 5_000_000,
    completionCostPerMillion: 25_000_000,
    cacheWriteCostPerMillion: 6_250_000,
    cacheWrite1hCostPerMillion: 10_000_000,
    cacheReadCostPerMillion: 500_000,
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    promptCostPerMillion: 3_000_000,
    completionCostPerMillion: 15_000_000,
    cacheWriteCostPerMillion: 3_750_000,
    cacheWrite1hCostPerMillion: 6_000_000,
    cacheReadCostPerMillion: 300_000,
  },
  {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    promptCostPerMillion: 1_000_000,
    completionCostPerMillion: 5_000_000,
    cacheWriteCostPerMillion: 1_250_000,
    cacheWrite1hCostPerMillion: 2_000_000,
    cacheReadCostPerMillion: 100_000,
  },
  // Claude 4.1 series
  {
    provider: 'anthropic',
    model: 'claude-opus-4-1',
    promptCostPerMillion: 15_000_000,
    completionCostPerMillion: 75_000_000,
    cacheWriteCostPerMillion: 18_750_000,
    cacheWrite1hCostPerMillion: 30_000_000,
    cacheReadCostPerMillion: 1_500_000,
  },
  // Claude 4 series
  {
    provider: 'anthropic',
    model: 'claude-opus-4',
    promptCostPerMillion: 15_000_000,
    completionCostPerMillion: 75_000_000,
    cacheWriteCostPerMillion: 18_750_000,
    cacheWrite1hCostPerMillion: 30_000_000,
    cacheReadCostPerMillion: 1_500_000,
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4',
    promptCostPerMillion: 3_000_000,
    completionCostPerMillion: 15_000_000,
    cacheWriteCostPerMillion: 3_750_000,
    cacheWrite1hCostPerMillion: 6_000_000,
    cacheReadCostPerMillion: 300_000,
  },
  // Claude 3.7 series
  {
    provider: 'anthropic',
    model: 'claude-3-7-sonnet',
    promptCostPerMillion: 3_000_000,
    completionCostPerMillion: 15_000_000,
    cacheWriteCostPerMillion: 3_750_000,
    cacheWrite1hCostPerMillion: 6_000_000,
    cacheReadCostPerMillion: 300_000,
  },
  // Claude 3.5 series
  {
    provider: 'anthropic',
    model: 'claude-3-5-haiku',
    promptCostPerMillion: 800_000,
    completionCostPerMillion: 4_000_000,
    cacheWriteCostPerMillion: 1_000_000,
    cacheWrite1hCostPerMillion: 1_600_000,
    cacheReadCostPerMillion: 80_000,
  },
  {
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    promptCostPerMillion: 3_000_000,
    completionCostPerMillion: 15_000_000,
    cacheWriteCostPerMillion: 3_750_000,
    cacheWrite1hCostPerMillion: 6_000_000,
    cacheReadCostPerMillion: 300_000,
  },
  // Claude 3 series (legacy)
  {
    provider: 'anthropic',
    model: 'claude-3-opus',
    promptCostPerMillion: 15_000_000,
    completionCostPerMillion: 75_000_000,
    cacheWriteCostPerMillion: 18_750_000,
    cacheWrite1hCostPerMillion: 30_000_000,
    cacheReadCostPerMillion: 1_500_000,
  },
  {
    provider: 'anthropic',
    model: 'claude-3-haiku',
    promptCostPerMillion: 250_000,
    completionCostPerMillion: 1_250_000,
    cacheWriteCostPerMillion: 300_000,
    cacheWrite1hCostPerMillion: 500_000,
    cacheReadCostPerMillion: 30_000,
  },

  // Google Gemini models
  // Gemini 3.x
  {
    provider: 'google',
    model: 'gemini-3.1-pro-preview',
    promptCostPerMillion: 2_000_000,
    completionCostPerMillion: 12_000_000,
    cacheReadCostPerMillion: 200_000,
  },
  {
    provider: 'google',
    model: 'gemini-3-pro-preview',
    promptCostPerMillion: 2_000_000,
    completionCostPerMillion: 12_000_000,
    cacheReadCostPerMillion: 200_000,
  },
  {
    provider: 'google',
    model: 'gemini-3-flash-preview',
    promptCostPerMillion: 500_000,
    completionCostPerMillion: 3_000_000,
    cacheReadCostPerMillion: 50_000,
  },
  // Gemini 2.5
  {
    provider: 'google',
    model: 'gemini-2.5-pro',
    promptCostPerMillion: 1_250_000,
    completionCostPerMillion: 10_000_000,
    cacheReadCostPerMillion: 125_000,
  },
  {
    provider: 'google',
    model: 'gemini-2.5-flash',
    promptCostPerMillion: 300_000,
    completionCostPerMillion: 2_500_000,
    cacheReadCostPerMillion: 30_000,
  },
  {
    provider: 'google',
    model: 'gemini-2.5-flash-lite',
    promptCostPerMillion: 100_000,
    completionCostPerMillion: 400_000,
    cacheReadCostPerMillion: 10_000,
  },
  // Gemini 2.0
  {
    provider: 'google',
    model: 'gemini-2.0-flash',
    promptCostPerMillion: 100_000,
    completionCostPerMillion: 400_000,
    cacheReadCostPerMillion: 25_000,
  },
  {
    provider: 'google',
    model: 'gemini-2.0-flash-lite',
    promptCostPerMillion: 75_000,
    completionCostPerMillion: 300_000,
  },

  // OpenAI models
  // GPT-5.x
  {
    provider: 'openai',
    model: 'gpt-5.3-codex',
    promptCostPerMillion: 1_750_000,
    completionCostPerMillion: 14_000_000,
    cacheReadCostPerMillion: 175_000,
  },
  {
    provider: 'openai',
    model: 'gpt-5.2',
    promptCostPerMillion: 1_750_000,
    completionCostPerMillion: 14_000_000,
    cacheReadCostPerMillion: 175_000,
  },
  {
    provider: 'openai',
    model: 'gpt-5.1',
    promptCostPerMillion: 1_250_000,
    completionCostPerMillion: 10_000_000,
    cacheReadCostPerMillion: 125_000,
  },
  {
    provider: 'openai',
    model: 'gpt-5.1-codex',
    promptCostPerMillion: 1_250_000,
    completionCostPerMillion: 10_000_000,
    cacheReadCostPerMillion: 125_000,
  },
  {
    provider: 'openai',
    model: 'gpt-5.1-codex-mini',
    promptCostPerMillion: 250_000,
    completionCostPerMillion: 2_000_000,
    cacheReadCostPerMillion: 25_000,
  },
  {
    provider: 'openai',
    model: 'gpt-5',
    promptCostPerMillion: 1_250_000,
    completionCostPerMillion: 10_000_000,
    cacheReadCostPerMillion: 125_000,
  },
  {
    provider: 'openai',
    model: 'gpt-5-mini',
    promptCostPerMillion: 250_000,
    completionCostPerMillion: 2_000_000,
    cacheReadCostPerMillion: 25_000,
  },
  {
    provider: 'openai',
    model: 'gpt-5-nano',
    promptCostPerMillion: 50_000,
    completionCostPerMillion: 400_000,
    cacheReadCostPerMillion: 5_000,
  },
  {
    provider: 'openai',
    model: 'gpt-5-codex',
    promptCostPerMillion: 1_250_000,
    completionCostPerMillion: 10_000_000,
    cacheReadCostPerMillion: 125_000,
  },
  // Reasoning models
  {
    provider: 'openai',
    model: 'o4-mini',
    promptCostPerMillion: 1_100_000,
    completionCostPerMillion: 4_400_000,
    cacheReadCostPerMillion: 275_000,
  },
  {
    provider: 'openai',
    model: 'o3-pro',
    promptCostPerMillion: 20_000_000,
    completionCostPerMillion: 80_000_000,
  },
  {
    provider: 'openai',
    model: 'o3',
    promptCostPerMillion: 2_000_000,
    completionCostPerMillion: 8_000_000,
    cacheReadCostPerMillion: 500_000,
  },
  {
    provider: 'openai',
    model: 'o3-mini',
    promptCostPerMillion: 1_100_000,
    completionCostPerMillion: 4_400_000,
    cacheReadCostPerMillion: 550_000,
  },
  // GPT-4.x
  {
    provider: 'openai',
    model: 'gpt-4.1',
    promptCostPerMillion: 2_000_000,
    completionCostPerMillion: 8_000_000,
    cacheReadCostPerMillion: 500_000,
  },
  {
    provider: 'openai',
    model: 'gpt-4.1-mini',
    promptCostPerMillion: 400_000,
    completionCostPerMillion: 1_600_000,
    cacheReadCostPerMillion: 100_000,
  },
  {
    provider: 'openai',
    model: 'gpt-4.1-nano',
    promptCostPerMillion: 100_000,
    completionCostPerMillion: 400_000,
    cacheReadCostPerMillion: 25_000,
  },
  {
    provider: 'openai',
    model: 'gpt-4o',
    promptCostPerMillion: 2_500_000,
    completionCostPerMillion: 10_000_000,
    cacheReadCostPerMillion: 1_250_000,
  },
  {
    provider: 'openai',
    model: 'gpt-4o-mini',
    promptCostPerMillion: 150_000,
    completionCostPerMillion: 600_000,
    cacheReadCostPerMillion: 75_000,
  },

  // Groq models - Production
  {
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    promptCostPerMillion: 590_000,
    completionCostPerMillion: 790_000,
  },
  {
    provider: 'groq',
    model: 'llama-3.1-8b-instant',
    promptCostPerMillion: 50_000,
    completionCostPerMillion: 80_000,
  },
  {
    provider: 'groq',
    model: 'meta-llama/llama-guard-4-12b',
    promptCostPerMillion: 200_000,
    completionCostPerMillion: 200_000,
  },
  {
    provider: 'groq',
    model: 'openai/gpt-oss-120b',
    promptCostPerMillion: 150_000,
    completionCostPerMillion: 600_000,
  },
  {
    provider: 'groq',
    model: 'openai/gpt-oss-20b',
    promptCostPerMillion: 75_000,
    completionCostPerMillion: 300_000,
  },
  {
    provider: 'groq',
    model: 'openai/gpt-oss-safeguard-20b',
    promptCostPerMillion: 75_000,
    completionCostPerMillion: 300_000,
    cacheReadCostPerMillion: 37_000,
  },

  // Groq models - Preview
  {
    provider: 'groq',
    model: 'meta-llama/llama-4-maverick-17b-128e-instruct',
    promptCostPerMillion: 200_000,
    completionCostPerMillion: 600_000,
  },
  {
    provider: 'groq',
    model: 'meta-llama/llama-4-scout-17b-16e-instruct',
    promptCostPerMillion: 110_000,
    completionCostPerMillion: 340_000,
  },
  {
    provider: 'groq',
    model: 'meta-llama/llama-prompt-guard-2-22m',
    promptCostPerMillion: 30_000,
    completionCostPerMillion: 30_000,
  },
  {
    provider: 'groq',
    model: 'meta-llama/llama-prompt-guard-2-86m',
    promptCostPerMillion: 40_000,
    completionCostPerMillion: 40_000,
  },
  {
    provider: 'groq',
    model: 'moonshotai/kimi-k2-instruct-0905',
    promptCostPerMillion: 1_000_000,
    completionCostPerMillion: 3_000_000,
  },
  {
    provider: 'groq',
    model: 'qwen/qwen3-32b',
    promptCostPerMillion: 290_000,
    completionCostPerMillion: 590_000,
  },

  // Groq models - Legacy/Alternative IDs
  {
    provider: 'groq',
    model: 'llama-3.1-70b-versatile',
    promptCostPerMillion: 590_000,
    completionCostPerMillion: 790_000,
  },
  {
    provider: 'groq',
    model: 'llama3-8b-8192',
    promptCostPerMillion: 50_000,
    completionCostPerMillion: 80_000,
  },
  {
    provider: 'groq',
    model: 'llama3-70b-8192',
    promptCostPerMillion: 590_000,
    completionCostPerMillion: 790_000,
  },
  {
    provider: 'groq',
    model: 'mixtral-8x7b-32768',
    promptCostPerMillion: 240_000,
    completionCostPerMillion: 240_000,
  },
  {
    provider: 'groq',
    model: 'gemma2-9b-it',
    promptCostPerMillion: 200_000,
    completionCostPerMillion: 200_000,
  },
];
