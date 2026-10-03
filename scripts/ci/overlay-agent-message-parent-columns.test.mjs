import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  PARENT_DATASOURCE_PATHS,
  planAgentMessageParentOverlay,
} from './overlay-agent-message-parent-columns.mjs';

const currentRef = 'c5aaa06a8c1cb88cc5345edcbbd3e7f57b61c136';
const current = (path) =>
  execFileSync('git', ['show', `${currentRef}:${path}`], { encoding: 'utf8' });
const repo = (path) => readFileSync(path, 'utf8');
const [factsPath, versionsPath] = PARENT_DATASOURCE_PATHS;
const appendedParents =
  '    `cost_usd` Nullable(Float64) `json:$.cost_usd`,\n' +
  "    `parent_vendor_session_id` String DEFAULT '' `json:$.parent_vendor_session_id`,\n" +
  "    `parent_session_pk` String DEFAULT '' `json:$.parent_session_pk`\n";
const originalCost = '    `cost_usd` Nullable(Float64) `json:$.cost_usd`\n';

describe('Agent parent-column expand overlay', () => {
  for (const path of PARENT_DATASOURCE_PATHS) {
    test(`${path} accepts only the additive migration`, () => {
      expect(planAgentMessageParentOverlay(path, current(path), repo(path))).toBe('additive');
      expect(planAgentMessageParentOverlay(path, repo(path), repo(path))).toBe('identical');
    });
  }

  test('rejects a datasource outside the two-file allowlist', () => {
    expect(() => planAgentMessageParentOverlay('datasources/other.datasource', '', '')).toThrow(
      /not allowlisted/,
    );
  });

  test.each([
    [
      'parent type',
      (text) =>
        text.replace(
          '`parent_session_pk` String DEFAULT',
          '`parent_session_pk` LowCardinality(String) DEFAULT',
        ),
    ],
    [
      'missing default',
      (text) => text.replace("`parent_session_pk` String DEFAULT ''", '`parent_session_pk` String'),
    ],
    ['wrong JSON path', (text) => text.replace('`json:$.parent_session_pk`', '`json:$.other`')],
    ['removed column', (text) => text.replace(/^    `model`.*\n/m, '')],
    [
      'reordered column',
      (text) => text.replace(/(    `vendor_message_id`[^\n]*\n)(    `turn_index`[^\n]*\n)/, '$2$1'),
    ],
    [
      'changed existing type',
      (text) => text.replace('`input_tokens` UInt32', '`input_tokens` UInt64'),
    ],
    [
      'third column',
      (text) =>
        text.replace(
          '    `vendor_message_id`',
          "    `extra` String DEFAULT '' `json:$.extra`,\n    `vendor_message_id`",
        ),
    ],
    [
      'duplicate parent column',
      (text) => text.replace(/(    `parent_session_pk`[^\n]*\n)/, '$1$1'),
    ],
    ['missing parent column', (text) => text.replace(/^    `parent_session_pk`[^\n]*\n/m, '')],
    ['engine', (text) => text.replace('ENGINE "MergeTree"', 'ENGINE "ReplacingMergeTree"')],
    [
      'sorting key',
      (text) =>
        text.replace(
          'ENGINE_SORTING_KEY "OrgId, session_pk, message_pk"',
          'ENGINE_SORTING_KEY "OrgId, message_pk"',
        ),
    ],
    ['TTL', (text) => text.replace('toIntervalYear(1)', 'toIntervalYear(2)')],
    [
      'forward query',
      (text) =>
        text.replace('ENGINE "MergeTree"', 'FORWARD_QUERY >\n  SELECT *\n\nENGINE "MergeTree"'),
    ],
    [
      'middle parent columns',
      (text) =>
        text
          .replace(appendedParents, originalCost)
          .replace(
            '    `vendor_session_id` String `json:$.vendor_session_id`,\n',
            '    `vendor_session_id` String `json:$.vendor_session_id`,\n' +
              "    `parent_vendor_session_id` String DEFAULT '' `json:$.parent_vendor_session_id`,\n" +
              "    `parent_session_pk` String DEFAULT '' `json:$.parent_session_pk`,\n",
          ),
    ],
    [
      'parent column order',
      (text) =>
        text.replace(
          appendedParents,
          '    `cost_usd` Nullable(Float64) `json:$.cost_usd`,\n' +
            "    `parent_session_pk` String DEFAULT '' `json:$.parent_session_pk`,\n" +
            "    `parent_vendor_session_id` String DEFAULT '' `json:$.parent_vendor_session_id`\n",
        ),
    ],
    [
      'unrelated appended column',
      (text) =>
        text.replace(
          "    `parent_session_pk` String DEFAULT '' `json:$.parent_session_pk`\n",
          "    `parent_session_pk` String DEFAULT '' `json:$.parent_session_pk`,\n" +
            "    `extra` String DEFAULT '' `json:$.extra`\n",
        ),
    ],
    [
      'changed cost column',
      (text) => text.replace('`cost_usd` Nullable(Float64)', '`cost_usd` Float64'),
    ],
  ])('rejects %s changes', (_label, mutate) => {
    expect(() =>
      planAgentMessageParentOverlay(factsPath, current(factsPath), mutate(repo(factsPath))),
    ).toThrow();
  });

  test('rejects changed schema after parent columns already exist', () => {
    const populated = repo(factsPath).replace('ENGINE "MergeTree"', 'ENGINE "ReplacingMergeTree"');
    expect(() => planAgentMessageParentOverlay(factsPath, repo(factsPath), populated)).toThrow(
      /already has parent columns/,
    );
  });

  test.each([
    ['token', (text) => text.replace('TOKEN trace_flow_agent_facts_append APPEND\n', '')],
    ['description', (text) => text.replace('One Agent Message', 'Changed Agent Message')],
  ])('rejects a parent-bearing current ref with a different %s', (_label, mutate) => {
    expect(() =>
      planAgentMessageParentOverlay(factsPath, mutate(repo(factsPath)), repo(factsPath)),
    ).toThrow(/already has parent columns/);
  });

  test('rejects a parent-bearing current ref with a stale forward query', () => {
    const latest = repo(versionsPath);
    const prior = latest.replace(
      'ENGINE "ReplacingMergeTree"',
      'FORWARD_QUERY >\n  SELECT *\n\nENGINE "ReplacingMergeTree"',
    );
    expect(() => planAgentMessageParentOverlay(versionsPath, prior, latest)).toThrow(
      /already has parent columns/,
    );
  });
});
