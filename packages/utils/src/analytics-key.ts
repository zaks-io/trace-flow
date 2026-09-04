import { sha256Hex } from './crypto';

export const ANALYTICS_KEY_PATTERN = /^sha256:[0-9a-f]{64}$/;

export async function analyticsKeyId(credential: string): Promise<string> {
  if (!credential) throw new Error('Missing API credential');
  return `sha256:${await sha256Hex(credential)}`;
}

// Queues and durable batches written before the cutover can still contain credentials.
export async function normalizeAnalyticsKey(value: string): Promise<string> {
  return ANALYTICS_KEY_PATTERN.test(value) ? value : analyticsKeyId(value);
}
