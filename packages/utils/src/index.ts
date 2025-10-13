export function generateId(): string {
  return crypto.randomUUID();
}

export function getCurrentTimestamp(): number {
  return Date.now();
}

export function extractProviderFromUrl(url: string): string {
  try {
    const hostname = new URL(url).hostname.toLowerCase();

    if (hostname.includes('openai.com')) return 'openai';
    if (hostname.includes('anthropic.com')) return 'anthropic';
    if (hostname.includes('generativelanguage.googleapis.com')) return 'google';
    if (hostname.includes('api.mistral.ai')) return 'mistral';
    if (hostname.includes('api.cohere.ai')) return 'cohere';
    if (hostname.includes('api.perplexity.ai')) return 'perplexity';

    return hostname;
  } catch {
    return 'unknown';
  }
}

export function generateSpanId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash);
}
