#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';

const canonical = new Map([
  ['agent_message_fact_versions', ['message_pk', 'EventAt']],
  ['agent_tool_event_fact_versions', ['tool_use_pk', 'EventAt']],
  ['agent_file_event_fact_versions', ['file_event_pk', 'EventAt']],
  ['agent_capability_snapshot_fact_versions', ['capability_snapshot_pk', 'EventAt']],
  ['agent_pull_request_fact_versions', ['pull_request_link_pk', 'EventAt']],
  ['agent_review_unit_attribution_versions', ['review_unit_attribution_pk', 'DecidedAt']],
]);
const serving = [
  'agent_context_call_buckets_hourly',
  'agent_repositories',
  'agent_session_file_signals',
  'agent_session_signals',
  'agent_session_summaries',
  'agent_tool_usage_daily',
  'agent_tool_usage_hourly',
  'agent_usage_daily',
  'agent_usage_hourly',
];
const endpointFiles = [
  'agent_context_health',
  'agent_cost_by_depth',
  'agent_failure_leaderboard',
  'agent_file_attention_top_directories',
  'agent_file_attention_top_files',
  'agent_notable_changes',
  'agent_priced_coverage',
  'agent_repo_directory',
  'agent_review_unit_costs',
  'agent_session_cost_distribution',
  'agent_session_signals_top_runaway',
  'agent_sessions_browser',
  'agent_tool_period_delta',
  'agent_usage_breakdown',
  'agent_usage_summary',
  'agent_usage_timeseries',
];
const failures = [];
const read = (path) => readFileSync(path, 'utf8');
const requireMatch = (path, pattern, message) => {
  if (!pattern.test(read(path))) failures.push(`${path}: ${message}`);
};

const baselineCopies = readdirSync('copies').filter((name) =>
  name.endsWith('_versions_baseline.pipe'),
);
if (baselineCopies.length !== canonical.size)
  failures.push(`expected ${canonical.size} baseline copies, found ${baselineCopies.length}`);
for (const name of baselineCopies) {
  requireMatch(
    `copies/${name}`,
    /toUInt64\(1\) AS DeliverySequence/,
    'baseline sequence must be explicitly reserved at 1',
  );
  requireMatch(
    `copies/${name}`,
    /SHA256\(/,
    'baseline rows need a deterministic typed-row content hash',
  );
  requireMatch(
    `copies/${name}`,
    /WHERE OrgId = \{\{ String\(org_id\) \}\}/,
    'baseline must be scoped to one verified organization',
  );
  requireMatch(
    `copies/${name}`,
    /\{\{ UInt64\(copy_attempt\) \}\} >= 1/,
    'baseline must retain its durable Copy attempt in job metadata',
  );
  if (/LIMIT 1 BY/.test(read(`copies/${name}`)))
    failures.push(`copies/${name}: baseline must not hide duplicate source identities`);
}

for (const [name, [pk, time]] of canonical) {
  const path = `datasources/${name}.datasource`;
  for (const column of ['DeliverySequence', 'ContentHash', 'IsDeleted']) {
    requireMatch(path, new RegExp('`' + column + '`'), `missing required ${column}`);
  }
  requireMatch(
    path,
    /ENGINE "ReplacingMergeTree"/,
    'canonical versions must use ReplacingMergeTree',
  );
  requireMatch(
    path,
    /ENGINE_VER "DeliverySequence"/,
    'DeliverySequence must select the latest version',
  );
  requireMatch(path, /ENGINE_IS_DELETED "IsDeleted"/, 'tombstones must mask the old day');
  requireMatch(
    path,
    new RegExp(`ENGINE_PARTITION_KEY \"toYYYYMM\\(${time}\\)\"`),
    'canonical versions must use bounded monthly partitions',
  );
  requireMatch(
    path,
    new RegExp(`ENGINE_SORTING_KEY "OrgId, toDate\\(${time}\\), session_pk, ${pk}"`),
    'the event day must be part of the replacement key',
  );
}

for (const name of serving) {
  const datasource = `datasources/${name}_snapshots.datasource`;
  requireMatch(datasource, /ENGINE "ReplacingMergeTree"/, 'snapshot retry rows must replace');
  requireMatch(
    datasource,
    /ENGINE_VER "CopyAttempt"/,
    'CopyAttempt must deterministically replace a retried generation row',
  );
  requireMatch(
    datasource,
    /ENGINE_PARTITION_KEY "toYYYYMM\(SnapshotDay\)"/,
    'snapshot copies must use bounded monthly partitions',
  );
  requireMatch(
    datasource,
    /ENGINE_TTL "toDateTime\(SnapshotDay\) \+ toIntervalYear\(1\) \+ toIntervalDay\(1\)"/,
    'day-grain snapshots must outlive every fact timestamp in the retained day',
  );
  const sortingKey =
    name === 'agent_session_summaries'
      ? /ENGINE_SORTING_KEY "OrgId, session_pk, SnapshotDay, SnapshotGeneration, SourceContributor"/
      : /ENGINE_SORTING_KEY "OrgId, SnapshotDay, SnapshotGeneration, SourceContributor, /;
  requireMatch(datasource, sortingKey, 'snapshot sorting key must preserve replacement identity');
  const copy = `copies/repair_${name}_snapshots.pipe`;
  requireMatch(copy, /TYPE COPY/, 'missing on-demand Copy Pipe');
  requireMatch(copy, /COPY_MODE append/, 'snapshot copies must append immutable generations');
  requireMatch(copy, /OrgId = \{\{ String\(org_id\) \}\}/, 'copy must prune by tenant');
  requireMatch(copy, /Array\(snapshot_days, 'Date'\)/, 'copy must be limited to captured days');
  requireMatch(copy, /SnapshotGeneration/, 'copy must tag its generation');
  requireMatch(copy, /SourceContributor/, 'copy must preserve independent contributors');
  requireMatch(copy, / FINAL/, 'copy must read corrected canonical facts');
  requireMatch(
    copy,
    /TOKEN agent_snapshot_worker READ/,
    'worker token must be scoped to this copy',
  );
  const published = `pipes/${name}_published.pipe`;
  requireMatch(
    published,
    /max\(SnapshotGeneration\)/,
    'published rows must select the latest commit per day',
  );
  requireMatch(
    published,
    /SnapshotDay >= if\([\s\S]*addYears\(today\(\), -1\)[\s\S]*SnapshotDay <= today\(\)/,
    'published manifest expansion must stay inside the calendar-year fact window',
  );
  requireMatch(
    published,
    new RegExp(`FROM ${name}_snapshots AS s FINAL`),
    'published reads must dedupe retries',
  );
}

const manifest = read('datasources/agent_snapshot_manifest.datasource');
if (/SnapshotGenerations/.test(manifest))
  failures.push('manifest must publish one generation for its full linked day set');
if (
  !/ENGINE "MergeTree"/.test(manifest) ||
  !/ENGINE_SORTING_KEY "OrgId, SnapshotGeneration"/.test(manifest)
) {
  failures.push('manifest must retain immutable organization generation commits');
}
requireMatch(
  'pipes/agent_snapshot_manifest_latest.pipe',
  /ARRAY JOIN SnapshotDays AS SnapshotDay/,
  'manifest endpoint must expand committed days',
);
requireMatch(
  'datasources/agent_snapshot_manifest.datasource',
  /ENGINE_TTL "toDateTime\(PublishedAt\) \+ toIntervalYear\(1\) \+ toIntervalDay\(1\)"/,
  'manifest metadata must outlive the day-grain snapshots it publishes',
);
requireMatch(
  'pipes/agent_snapshot_manifest_latest.pipe',
  /max\(manifest_generation\)/,
  'late older commits must not revert a day',
);
requireMatch(
  'pipes/agent_snapshot_manifest_latest.pipe',
  /SnapshotDay >= \{\{ Date\(oldest_day\) \}\}[\s\S]*SnapshotDay <= \{\{ Date\(today_day\) \}\}[\s\S]*LIMIT 367/,
  'manifest cleanup endpoint must filter the retained calendar-year window before its row cap',
);
requireMatch(
  'pipes/agent_snapshot_job.pipe',
  /INTERVAL 10 MINUTE/,
  'job polling must bound the service-table scan',
);
requireMatch(
  'pipes/agent_snapshot_copy_intent_jobs.pipe',
  /throwIf\(not\(has\(allowed_targets, requested_target\)\)/,
  'intent reconciliation must reject unknown targets',
);
requireMatch(
  'pipes/agent_snapshot_copy_intent_jobs.pipe',
  /LIMIT 2/,
  'intent reconciliation must surface duplicate starts',
);
requireMatch(
  'pipes/agent_snapshot_copy_intent_jobs.pipe',
  /started_at_ms/,
  'intent reconciliation must use the durable start boundary',
);

const receiptViews = readdirSync('materializations').filter((name) =>
  name.startsWith('materialize_agent_delivery_receipts_'),
);
const identityViews = readdirSync('materializations').filter((name) =>
  name.startsWith('materialize_agent_fact_identity_days_'),
);
if (receiptViews.length !== canonical.size)
  failures.push(`expected ${canonical.size} receipt views, found ${receiptViews.length}`);
if (identityViews.length !== canonical.size)
  failures.push(`expected ${canonical.size} identity-day views, found ${identityViews.length}`);
for (const name of receiptViews)
  requireMatch(`materializations/${name}`, /IsDeleted/, 'receipts must include tombstones');
for (const name of identityViews)
  requireMatch(
    `materializations/${name}`,
    /WHERE IsDeleted = 0/,
    'identity-day index must track live rows',
  );
for (const name of identityViews)
  requireMatch(
    `materializations/${name}`,
    /ContentHash/,
    'identity-day index must retain the current content hash',
  );
requireMatch(
  'pipes/agent_fact_identity_day.pipe',
  /DeliverySequence, ContentHash/,
  'identity-day endpoint must return the current content proof',
);
requireMatch(
  'datasources/agent_fact_identity_days.datasource',
  /ENGINE_SORTING_KEY "OrgId, Category, FactIdentity"/,
  'identity-day replacement identity must remain stable across event-month corrections',
);
requireMatch(
  'pipes/agent_fact_identity_day.pipe',
  /FROM agent_fact_identity_days FINAL/,
  'identity-day endpoint must reconcile versions across event-month partitions',
);
requireMatch(
  'pipes/agent_fact_identity_day.pipe',
  /EventDay >= \{\{ Date\(oldest_day\) \}\}[\s\S]*EventDay <= \{\{ Date\(today_day\) \}\}/,
  'identity-day endpoint must exclude asynchronously retained rows outside caller retention bounds',
);
requireMatch(
  'datasources/agent_fact_identity_days.datasource',
  /ENGINE_TTL "toDateTime\(EventDay\) \+ toIntervalYear\(1\) \+ toIntervalDay\(1\)"/,
  'day-grain identity metadata must outlive every fact timestamp in the retained day',
);

for (const name of endpointFiles) {
  const content = read(`pipes/${name}.pipe`);
  if (
    /\bFROM agent_(context_call_buckets_hourly|repositories|session_file_signals|session_signals|session_summaries|tool_usage_daily|tool_usage_hourly|usage_daily|usage_hourly)\b/.test(
      content,
    )
  ) {
    failures.push(`pipes/${name}.pipe: endpoint still reads an incremental serving table`);
  }
}

if (failures.length) {
  console.error('Agent snapshot contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log(
  'Agent snapshot contract passed: 6 canonical tables, 9 Copy targets, 16 endpoint contracts',
);
