import { ANALYTICS_KEY_PATTERN } from '@trace-flow/utils';

export function sanitizeAnalyticsKeyIds(ids: string[]): string[] {
  return ids.filter((id) => ANALYTICS_KEY_PATTERN.test(id));
}

export const NORMALIZED_API_KEY_SQL =
  "if(match(ApiKey, '^sha256:[0-9a-f]{64}$'), ApiKey, concat('sha256:', lower(hex(SHA256(ApiKey)))))";

export function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
