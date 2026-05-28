import type { AgentTimeseriesRow } from './types';

/** Sentinel group for the aggregated tail when top-N capping is applied. Not clickable. */
export const OTHER_GROUP = 'Other';

interface PivotedSeries {
  /** One row per bucket: { bucket_start, [groupValue]: metricValue, ... }. */
  data: Array<Record<string, string | number>>;
  /** Distinct group values, ordered by total metric value descending (stable stack/legend). */
  groups: string[];
}

/**
 * Pivot long group-by rows (one per bucket+group) into wide chart rows (one per bucket,
 * a column per group value). Rows with an empty group_value are dropped — they are the
 * ungrouped or cross-dimension-unmatched rows (e.g. tool events when grouping by model),
 * which have no place in a grouped series.
 *
 * When topN is set and there are more groups than that, the lower-ranked groups (by total
 * metric value) collapse into a single OTHER_GROUP series so a high-cardinality dimension
 * (repo) stays legible.
 */
export function pivotByGroup(
  rows: AgentTimeseriesRow[],
  metricKey: keyof AgentTimeseriesRow,
  topN?: number,
): PivotedSeries {
  const byBucket = new Map<string, Record<string, string | number>>();
  const totals = new Map<string, number>();

  for (const row of rows) {
    const group = row.group_value;
    if (!group) continue;
    const value = Number(row[metricKey] ?? 0);

    let bucket = byBucket.get(row.bucket_start);
    if (!bucket) {
      bucket = { bucket_start: row.bucket_start };
      byBucket.set(row.bucket_start, bucket);
    }
    bucket[group] = (Number(bucket[group] ?? 0) || 0) + value;
    totals.set(group, (totals.get(group) ?? 0) + value);
  }

  const ranked = [...totals.keys()].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0));
  const capped = topN !== undefined && ranked.length > topN;
  const kept = capped ? ranked.slice(0, topN) : ranked;
  const tail = capped ? ranked.slice(topN) : [];
  const groups = capped ? [...kept, OTHER_GROUP] : kept;

  const data = [...byBucket.values()].map((bucket) => {
    if (capped) {
      let other = 0;
      for (const group of tail) {
        other += Number(bucket[group] ?? 0);
        delete bucket[group];
      }
      bucket[OTHER_GROUP] = other;
    }
    // Zero-fill missing kept groups per bucket so stacked areas/lines stay continuous.
    for (const group of groups) {
      if (bucket[group] === undefined) bucket[group] = 0;
    }
    return bucket;
  });

  return { data, groups };
}
