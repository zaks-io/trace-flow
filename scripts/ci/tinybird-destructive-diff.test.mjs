import { test, expect } from 'bun:test';
import { allowDestructiveOperations, deploymentResult } from './tinybird-destructive-diff.mjs';

const result = (datasources = [], pipes = [], connections = [], tokens = []) => ({
  deleted_datasource_names: datasources,
  deleted_pipe_names: pipes,
  deleted_data_connector_names: connections,
  token_changes: tokens,
});

test('allows only the reviewed retirement inventory and leaves a clean diff unflagged', () => {
  expect(allowDestructiveOperations(result(['agent_messages'], ['agent_fact_identity_day']))).toBe(
    true,
  );
  expect(allowDestructiveOperations(result())).toBe(false);
});

test('refuses mixed and unlisted deletions with the offending resource names', () => {
  for (const [diff, name] of [
    [result(['agent_messages', 'agent_message_fact_versions']), 'agent_message_fact_versions'],
    [result([], ['agent_usage_summary']), 'agent_usage_summary'],
    [result([], [], ['live_connection']), 'live_connection'],
    [result([], [], [], [{ change_type: 'deleted', token_name: 'live_token' }]), 'live_token'],
  ]) {
    expect(() => allowDestructiveOperations(diff)).toThrow(name);
  }
});

test('guards token deletions and permission removal without retiring live targets', () => {
  expect(
    allowDestructiveOperations(
      result(
        [],
        [],
        [],
        [
          { change_type: 'deleted', token_name: 'agent_snapshot_migration' },
          {
            change_type: 'updated',
            permission_changes: {
              removed_permissions: [
                { resource_type: 'pipe', resource_name: 'agent_fact_identity_day' },
              ],
            },
          },
        ],
      ),
    ),
  ).toBe(true);
  expect(() =>
    allowDestructiveOperations(
      result(
        [],
        [],
        [],
        [
          {
            change_type: 'updated',
            permission_changes: {
              removed_permissions: [
                { resource_type: 'datasource', resource_name: 'agent_message_fact_versions' },
              ],
            },
          },
        ],
      ),
    ),
  ).toThrow('agent_message_fact_versions');
});

test('parses real CLI human output followed by JSON and fails closed on incomplete inventory', () => {
  expect(
    deploymentResult(`Human diff\n${JSON.stringify(result(['agent_messages']))}\nDone`),
  ).toEqual(result(['agent_messages']));
  for (const field of Object.keys(result())) {
    const incomplete = result();
    delete incomplete[field];
    expect(() => deploymentResult(JSON.stringify(incomplete))).toThrow(
      'structured deletion inventory',
    );
  }
  expect(() =>
    allowDestructiveOperations(result([], [], [], [{ change_type: 'unknown' }])),
  ).toThrow('Unknown Tinybird token change');
  for (const removed_permissions of [null, {}, 'invalid']) {
    expect(() =>
      allowDestructiveOperations(
        result(
          [],
          [],
          [],
          [{ change_type: 'updated', permission_changes: { removed_permissions } }],
        ),
      ),
    ).toThrow('removed token permissions');
  }
});

test('accepts additive token updates when removed_permissions is omitted', () => {
  for (const permission_changes of [
    undefined,
    {},
    { added_permissions: [{ resource_type: 'pipe', resource_name: 'agent_usage_summary' }] },
  ]) {
    expect(
      allowDestructiveOperations(
        result([], [], [], [{ change_type: 'updated', permission_changes }]),
      ),
    ).toBe(false);
  }
});
