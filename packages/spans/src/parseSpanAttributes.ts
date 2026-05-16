/**
 * Safely parses span attributes from either a JSON string (database) or
 * an already-parsed object (Tinybird API) into a string record.
 */
export function parseSpanAttributes(
  attributes: string | Record<string, string>,
): Record<string, string> {
  try {
    return typeof attributes === 'string'
      ? (JSON.parse(attributes) as Record<string, string>)
      : attributes;
  } catch {
    return {};
  }
}
