/** Percent change of `current` vs the prior period; null when there is no prior baseline. */
export function computeDelta(current: number, prior: number): number | null {
  if (prior === 0) return null;
  return ((current - prior) / prior) * 100;
}
