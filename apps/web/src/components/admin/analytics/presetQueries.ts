function quoteDataset(dataset: string) {
  return `"${dataset.replace(/"/g, '""')}"`;
}

export function buildDefaultQuery(dataset: string) {
  const tableName = quoteDataset(dataset);
  return `SELECT
  formatDateTime(timestamp, '%Y-%m-%d %H:%M:%S') AS bucket,
  index1 AS org_id,
  blob1 AS provider,
  blob2 AS status_code,
  blob3 AS operation,
  double1 AS total_latency_ms,
  double5 AS total_tokens
FROM ${tableName}
WHERE __TIME_FILTER__
ORDER BY timestamp DESC
LIMIT 100`;
}

export function buildPresetQuery(dataset: string, preset: 'slow' | 'skips' | 'orgs') {
  const tableName = quoteDataset(dataset);
  if (preset === 'slow') {
    return `SELECT
  formatDateTime(timestamp, '%Y-%m-%d %H:%M:%S') AS ts,
  index1 AS org_id,
  blob1 AS provider,
  blob6 AS model,
  double1 AS total_latency_ms,
  double3 AS ttfb_ms,
  double5 AS total_tokens
FROM ${tableName}
WHERE __TIME_FILTER__ AND double1 > 2000
ORDER BY total_latency_ms DESC
LIMIT 100`;
  }

  if (preset === 'skips') {
    return `SELECT
  if(blob4 = '', '(none)', blob4) AS skip_reason,
  SUM(_sample_interval) AS request_count,
  SUM(_sample_interval * double5) AS total_tokens
FROM ${tableName}
WHERE __TIME_FILTER__
GROUP BY skip_reason
ORDER BY request_count DESC
LIMIT 50`;
  }

  return `SELECT
  index1 AS org_id,
  SUM(_sample_interval) AS request_count,
  sumIf(_sample_interval, double4 > 0) AS server_error_count,
  quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_latency_ms,
  SUM(_sample_interval * double5) AS total_tokens
FROM ${tableName}
WHERE __TIME_FILTER__
GROUP BY org_id
ORDER BY request_count DESC
LIMIT 50`;
}
