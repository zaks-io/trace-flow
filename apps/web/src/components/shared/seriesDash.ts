// Dash patterns are the second identity channel beside color where lines can cross (ADR 0010).
// Five patterns mean series five positions apart share one; no slot pair that fails the
// validator sits five apart. The most confusable pair (slots 1 and 7) lands on solid vs long
// dash in groups and on long dash vs sparse dots for Cache Read vs Reasoning.
const SERIES_DASHES = [undefined, '8 4', '12 3 3 3', '2 3', '1 6'] as const;

export function seriesDash(index: number): string | undefined {
  return SERIES_DASHES[index % SERIES_DASHES.length];
}
