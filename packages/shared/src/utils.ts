export function generateId(): string {
  return crypto.randomUUID();
}

export function getCurrentTimestamp(): number {
  return Date.now();
}
