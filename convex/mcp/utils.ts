export function escapeSQL(value: string): string {
  return value.replace(/'/g, "''");
}

export function formatNumber(value: number): number {
  if (value === 0 || !Number.isFinite(value)) return value;
  // Round to 6 decimal places for reasonable precision on micro-costs
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'number') {
    return formatNumber(value);
  }
  return value;
}

export function buildApiKeyFilter(apiKeys: string[]): string {
  if (apiKeys.length === 0) return '';
  const escaped = apiKeys.map((k) => `'${escapeSQL(k)}'`).join(', ');
  return `ApiKey IN (${escaped})`;
}

export function stripNulls<T>(obj: T): T | undefined {
  if (obj === null || obj === undefined) return undefined;
  if (Array.isArray(obj)) {
    const filtered = obj.map(stripNulls).filter((v) => v !== undefined);
    return filtered.length > 0 ? (filtered as T) : undefined;
  }
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const stripped = stripNulls(value);
      if (stripped !== undefined) result[key] = stripped;
    }
    return Object.keys(result).length > 0 ? (result as T) : undefined;
  }
  return obj;
}
