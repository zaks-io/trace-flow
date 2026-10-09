import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const RETIRED_RESOURCES = JSON.parse(
  readFileSync(new URL('./tinybird-retired-resources.json', import.meta.url), 'utf8'),
);
export const INITIAL_APPROVAL = 'trace_flow_prod_20261009';

export function deploymentResult(output) {
  // Tinybird prints its human diff before the JSON result, even with --output json.
  for (let index = output.indexOf('{'); index >= 0; index = output.indexOf('{', index + 1)) {
    try {
      const result = JSON.parse(output.slice(index, output.lastIndexOf('}') + 1));
      if (
        Array.isArray(result.deleted_datasource_names) &&
        Array.isArray(result.deleted_pipe_names)
      )
        return result;
    } catch {
      continue;
    }
  }
  throw new Error('Tinybird check returned no structured deletion inventory');
}

export function approveCleanup(result, approval, now = new Date(), initialConsumed = true) {
  const drops = [
    ...result.deleted_datasource_names.map((name) => ['datasources', name]),
    ...result.deleted_pipe_names.map((name) => ['pipes', name]),
    ...(result.deleted_data_connector_names ?? []).map((name) => ['connections', name]),
  ];
  for (const change of result.token_changes ?? []) {
    if (change.change_type === 'deleted') drops.push(['tokens', change.token_name]);
    else {
      for (const permission of change.permission_changes?.removed_permissions ?? []) {
        const kind =
          permission.resource_type === 'datasource'
            ? 'datasources'
            : permission.resource_type === 'pipe'
              ? 'pipes'
              : 'connections';
        drops.push([kind, permission.resource_name]);
      }
    }
  }
  if (drops.length === 0) return false;
  const initialDrop = drops.every(([kind, name]) => RETIRED_RESOURCES[kind]?.includes(name));
  if (approval === INITIAL_APPROVAL && initialDrop && !initialConsumed) return true;
  const today = `trace_flow_prod_${now.toISOString().slice(0, 10).replaceAll('-', '')}`;
  if (approval && approval !== INITIAL_APPROVAL && approval === today) return true;
  throw new Error(
    'Refusing destructive prod deploy without a fresh dated TINYBIRD_CLEANUP_APPROVED value',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = deploymentResult(readFileSync(process.argv[2], 'utf8'));
  if (!['true', 'false'].includes(process.argv[3]))
    throw new Error('Verified cleanup receipt state is required');
  console.log(
    approveCleanup(
      result,
      process.env.TINYBIRD_CLEANUP_APPROVED,
      new Date(),
      process.argv[3] === 'true',
    )
      ? '1'
      : '0',
  );
}
