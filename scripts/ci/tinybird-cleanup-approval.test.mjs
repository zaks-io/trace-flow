import { test, expect } from 'bun:test';
import {
  approveCleanup,
  deploymentResult,
  INITIAL_APPROVAL,
} from './tinybird-cleanup-approval.mjs';
const result = (datasources = [], pipes = [], connections = []) => ({
  deleted_datasource_names: datasources,
  deleted_pipe_names: pipes,
  deleted_data_connector_names: connections,
});
test('initial approval only permits the retired drop set and cannot authorize future deletion', () => {
  expect(approveCleanup(result(['agent_messages']), INITIAL_APPROVAL, new Date(), false)).toBe(
    true,
  );
  expect(approveCleanup(result(), INITIAL_APPROVAL)).toBe(false);
  for (const change of [
    result(['agent_message_fact_versions']),
    result([], ['agent_usage_summary']),
    result([], [], ['live_connection']),
  ]) {
    expect(() => approveCleanup(change, INITIAL_APPROVAL)).toThrow('fresh dated');
    expect(() => approveCleanup(change, undefined)).toThrow('fresh dated');
  }
});
test('future destructive changes require a current dated approval', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  expect(() => approveCleanup(result(['live_table']), 'trace_flow_prod_20261008', now)).toThrow(
    'fresh dated',
  );
  expect(approveCleanup(result(['live_table']), 'trace_flow_prod_20261010', now)).toBe(true);
});
test('reads the provider check result after human output and fails closed without inventory', () => {
  expect(
    deploymentResult(`Human diff\n${JSON.stringify(result(['agent_messages']))}\nDone`),
  ).toEqual(result(['agent_messages']));
  expect(() => deploymentResult('{"status":"success"}')).toThrow('structured deletion inventory');
});

test('consumed initial approval cannot be reused even for restored retired resources', () => {
  expect(() =>
    approveCleanup(result(['agent_messages']), INITIAL_APPROVAL, new Date('2026-12-01'), true),
  ).toThrow('fresh dated');
});
test('token-only deletions and live permission removals need approval', () => {
  const retired = {
    ...result(),
    token_changes: [{ change_type: 'deleted', token_name: 'agent_snapshot_migration' }],
  };
  expect(approveCleanup(retired, INITIAL_APPROVAL, new Date(), false)).toBe(true);
  expect(() => approveCleanup(retired, INITIAL_APPROVAL, new Date(), true)).toThrow('fresh dated');
  const live = {
    ...result(),
    token_changes: [
      {
        change_type: 'updated',
        permission_changes: {
          removed_permissions: [
            { resource_type: 'datasource', resource_name: 'agent_message_fact_versions' },
          ],
        },
      },
    ],
  };
  expect(() => approveCleanup(live, INITIAL_APPROVAL, new Date(), false)).toThrow('fresh dated');
});
