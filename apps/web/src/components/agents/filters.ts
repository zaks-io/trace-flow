/** Toggle a value in a multi-select list: add when absent, remove when present. */
export function toggleInList<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}
