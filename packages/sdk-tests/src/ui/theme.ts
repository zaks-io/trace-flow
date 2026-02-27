export const providerColors: Record<string, string> = {
  openai: '#10a37f',
  anthropic: '#d4a574',
  google: '#4285f4',
  openrouter: '#9b59b6',
  groq: '#f39c12',
};

export const statusColors = {
  passed: '#22c55e',
  failed: '#ef4444',
  skipped: '#6b7280',
  running: '#eab308',
  pending: '#4b5563',
} as const;

export const chars = {
  passed: '\u25cf', // ●
  failed: '\u2717', // ✗
  skipped: '\u2013', // –
  running: '\u25d0', // ◐
  pending: '\u25cb', // ○
  dot: '\u00b7', // ·
} as const;

export function getProviderColor(providerId: string): string {
  return providerColors[providerId] ?? '#888888';
}
