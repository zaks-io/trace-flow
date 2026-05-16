export function sortFilterOptions(
  options: readonly string[],
  labelMap?: ReadonlyMap<string, string>,
): string[] {
  const unique = [...new Set(options)];
  return unique.sort((a, b) => {
    const labelA = labelMap?.get(a) ?? a;
    const labelB = labelMap?.get(b) ?? b;
    return labelA.localeCompare(labelB, undefined, { sensitivity: 'base' });
  });
}
