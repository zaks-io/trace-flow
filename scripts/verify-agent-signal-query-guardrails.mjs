#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '.');
const maxPublicRows = 100;

const knownSignalPipes = new Set([
  'agent_context_health',
  'agent_failure_leaderboard',
  'agent_file_attention_top_directories',
  'agent_file_attention_top_files',
  'agent_notable_changes',
  'agent_repo_directory',
  'agent_review_unit_costs',
  'agent_session_cost_distribution',
  'agent_session_signals_top_runaway',
  'agent_sessions_browser',
  'agent_tool_period_delta',
]);

const accountWideSummaries = new Map([
  ['agent_context_health', { maxRows: maxPublicRows, reason: 'bounded aggregate rows' }],
  ['agent_failure_leaderboard', { maxRows: maxPublicRows, reason: 'bounded tool leaderboard' }],
  ['agent_notable_changes', { maxRows: maxPublicRows, reason: 'bounded daily-baseline movers' }],
  ['agent_repo_directory', { maxRows: maxPublicRows, reason: 'bounded repo discovery' }],
  [
    'agent_review_unit_costs',
    { maxRows: maxPublicRows, reason: 'bounded review-unit leaderboard' },
  ],
  [
    'agent_session_cost_distribution',
    { singleRow: true, reason: 'single aggregate distribution row' },
  ],
  ['agent_sessions_browser', { maxRows: maxPublicRows, reason: 'bounded session browser page' }],
  ['agent_tool_period_delta', { maxRows: maxPublicRows, reason: 'bounded tool-delta leaderboard' }],
]);

const repoScopedSignalPipes = new Set([
  'agent_file_attention_top_directories',
  'agent_file_attention_top_files',
  'agent_session_signals_top_runaway',
]);

const signalMaterializationTargets = new Set([
  'agent_context_call_buckets_hourly',
  'agent_repositories',
  'agent_session_file_signals',
  'agent_session_signals',
  'agent_session_summaries',
]);

const performanceProbes = [
  {
    family: 'session risk',
    pipe: 'agent_session_signals_top_runaway',
    test: 'agent_session_signals_top_runaway',
  },
  {
    family: 'file hotspots',
    pipe: 'agent_file_attention_top_files',
    test: 'agent_file_attention_top_files',
  },
  { family: 'tool failures', pipe: 'agent_failure_leaderboard', test: 'agent_failure_leaderboard' },
  { family: 'repo baselines', pipe: 'agent_notable_changes', test: 'agent_notable_changes' },
];

const failures = [];
const checkedEndpoints = [];
const checkedMaterializations = [];

function fail(file, message) {
  failures.push(`${file}: ${message}`);
}

function listFiles(dir, suffix) {
  const absolute = path.join(root, dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(relative, suffix);
    return entry.isFile() && entry.name.endsWith(suffix) ? [relative] : [];
  });
}

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

function pipeName(relativePath) {
  return path.basename(relativePath, '.pipe');
}

function compactSql(content) {
  return content.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim();
}

function isSignalEndpoint(name, content) {
  if (!/\bTYPE\s+ENDPOINT\b/i.test(content)) return false;
  if (knownSignalPipes.has(name)) return true;
  return /^agent_.*(signal|risk|hotspot|baseline|failure|file_attention|context_health|tool_period_delta|repo_directory|review_unit)/.test(
    name,
  );
}

function hasOrgScope(sql) {
  return /\bOrgId\s*=\s*\{\{\s*String\(org_id\b/i.test(sql);
}

function hasTimeWindowClamp(sql) {
  return (
    /\bstart_time_ms\b/.test(sql) &&
    /\bend_time_ms\b/.test(sql) &&
    /\bstart_dt\b/.test(sql) &&
    /\bend_dt\b/.test(sql) &&
    />=\s*(prior_start_dt|scan_start_dt|start_dt)\b/i.test(sql) &&
    /<\s*end_dt\b/i.test(sql)
  );
}

function hasStrictRepoScope(sql) {
  return (
    /\brepo_fingerprint\b/.test(sql) &&
    /{%\s*if\s+defined\((repos|repo_fingerprint)\)\s*%}/.test(sql) &&
    /{%\s*else\s*%}\s*AND\s+0\b/i.test(sql)
  );
}

function clampedLimitCap(sql) {
  const matches = [
    ...sql.matchAll(
      /\bLIMIT\s+greatest\(1,\s*least\(\{\{\s*Int32\(limit(?:,\s*\d+)?\)\s*\}\},\s*(\d+)\s*\)\s*\)/gi,
    ),
  ];
  if (matches.length === 0) return undefined;
  return Math.max(...matches.map((match) => Number(match[1])));
}

function checkEndpoint(relativePath) {
  const name = pipeName(relativePath);
  const content = read(relativePath);
  if (!isSignalEndpoint(name, content)) return;

  const sql = compactSql(content);
  const accountWide = accountWideSummaries.get(name);
  checkedEndpoints.push(name);

  if (!hasOrgScope(sql)) {
    fail(relativePath, 'public signal endpoint must filter by OrgId = {{ String(org_id, ...) }}');
  }

  if (!hasTimeWindowClamp(sql)) {
    fail(
      relativePath,
      'public signal endpoint must derive start/end params and filter to that time window',
    );
  }

  if (repoScopedSignalPipes.has(name) || !accountWide) {
    if (!hasStrictRepoScope(sql)) {
      fail(
        relativePath,
        'signal endpoint must require repos/repo_fingerprint or explicitly join the account-wide allowlist',
      );
    }
  }

  if (!accountWide?.singleRow) {
    const limitCap = clampedLimitCap(sql);
    if (limitCap === undefined) {
      fail(
        relativePath,
        'signal endpoint must clamp LIMIT with greatest(1, least({{ Int32(limit, default) }}, max))',
      );
    } else if (limitCap > (accountWide?.maxRows ?? maxPublicRows)) {
      fail(
        relativePath,
        `signal endpoint row cap ${limitCap} exceeds ${accountWide?.maxRows ?? maxPublicRows}`,
      );
    }
  }

  if (/\bgroup(?:Uniq)?Array\s*\(/i.test(sql) && !accountWide?.singleRow) {
    fail(
      relativePath,
      'signal endpoint must not build unbounded aggregate arrays unless it is an explicit single-row summary',
    );
  }

  if (
    /\b(command_excerpt|error_excerpt|raw_transcript|transcript_text|message_text)\b/i.test(sql)
  ) {
    fail(relativePath, 'MCP-facing signal endpoint must not expose raw transcript or excerpt text');
  }

  if (/\bFINAL\b/i.test(sql)) {
    fail(
      relativePath,
      'public signal endpoint must not use FINAL; broad FINAL scans are admin diagnostics only',
    );
  }
}

function materializationTarget(content) {
  const match = content.match(/\bDATASOURCE\s+([A-Za-z0-9_]+)/);
  return match?.[1];
}

function checkMaterialization(relativePath) {
  const content = read(relativePath);
  const target = materializationTarget(content);
  const isSignalTarget =
    (target && signalMaterializationTargets.has(target)) ||
    /agent_.*(signal|baseline)/.test(relativePath);
  if (!isSignalTarget) return;

  const sql = compactSql(content);
  checkedMaterializations.push(relativePath);

  if (!/\bTYPE\s+MATERIALIZED\b/i.test(sql)) {
    fail(relativePath, 'signal serving writes must be incremental TYPE MATERIALIZED resources');
  }
  if (/\bCOPY_SCHEDULE\b/i.test(sql) || /\bCOPY_MODE\s+replace\b/i.test(sql)) {
    fail(relativePath, 'scheduled or replacement signal materialization is not allowed');
  }
  if (/\bPOPULATE\b/i.test(sql)) {
    fail(relativePath, 'signal materialization must not backfill all history with POPULATE');
  }
  if (/\bFINAL\b/i.test(sql)) {
    fail(relativePath, 'signal materialization must not read raw tables with FINAL');
  }
  if (!/\bGROUP\s+BY\b[^;]*(\bOrgId\b)/i.test(sql)) {
    fail(relativePath, 'signal materialization must aggregate by OrgId and a stable serving grain');
  }
}

for (const file of listFiles('pipes', '.pipe')) {
  checkEndpoint(file);
}

for (const file of listFiles('materializations', '.pipe')) {
  checkMaterialization(file);
}

for (const probe of performanceProbes) {
  if (!checkedEndpoints.includes(probe.pipe)) {
    fail(
      'scripts/verify-agent-signal-query-guardrails.mjs',
      `missing performance probe endpoint ${probe.pipe}`,
    );
  }
}

if (failures.length > 0) {
  console.error('Agent signal query guardrails failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Agent signal query guardrails passed');
console.log(`Checked signal endpoints: ${checkedEndpoints.sort().join(', ')}`);
console.log(`Checked signal materializations: ${checkedMaterializations.sort().join(', ')}`);
console.log(
  `Representative performance probes: ${performanceProbes
    .map((probe) => `${probe.family}=${probe.pipe}/${probe.test}`)
    .join(', ')}`,
);
