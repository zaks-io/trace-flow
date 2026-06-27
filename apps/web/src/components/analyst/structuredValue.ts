export function formatStructuredValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(formatStructuredValue).filter(Boolean).join('\n');
  if (typeof value !== 'object') return String(value);

  return Object.entries(value)
    .map(([key, entry]) => {
      const formatted = formatStructuredValue(entry);
      return formatted ? `${key}: ${formatted}` : '';
    })
    .filter(Boolean)
    .join('\n');
}
