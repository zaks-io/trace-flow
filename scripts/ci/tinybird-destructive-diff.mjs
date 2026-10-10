import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const RETIRED_RESOURCES = JSON.parse(
  readFileSync(new URL('./tinybird-retired-resources.json', import.meta.url), 'utf8'),
);

export function deploymentResult(output) {
  // Tinybird prints its human diff before the JSON result, even with --output json.
  for (let index = output.indexOf('{'); index >= 0; index = output.indexOf('{', index + 1)) {
    try {
      const result = JSON.parse(output.slice(index, output.lastIndexOf('}') + 1));
      if (
        Array.isArray(result.deleted_datasource_names) &&
        Array.isArray(result.deleted_pipe_names) &&
        Array.isArray(result.deleted_data_connector_names) &&
        Array.isArray(result.token_changes)
      )
        return result;
    } catch {
      continue;
    }
  }
  throw new Error('Tinybird check returned no structured deletion inventory');
}

export function allowDestructiveOperations(result) {
  const drops = [
    ...result.deleted_datasource_names.map((name) => ['datasources', name]),
    ...result.deleted_pipe_names.map((name) => ['pipes', name]),
    ...result.deleted_data_connector_names.map((name) => ['connections', name]),
  ];
  for (const change of result.token_changes) {
    if (change.change_type === 'deleted') drops.push(['tokens', change.token_name]);
    else if (change.change_type === 'updated') {
      const removedPermissions = change.permission_changes?.removed_permissions;
      if (removedPermissions !== undefined && !Array.isArray(removedPermissions))
        throw new Error('Tinybird check returned invalid removed token permissions');
      for (const permission of removedPermissions ?? []) {
        const kind = { datasource: 'datasources', pipe: 'pipes', connection: 'connections' }[
          permission.resource_type
        ];
        drops.push([kind, permission.resource_name]);
      }
    } else if (change.change_type !== 'created') {
      throw new Error(`Unknown Tinybird token change type: ${change.change_type}`);
    }
  }
  const unlisted = drops.filter(
    ([kind, name]) => typeof name !== 'string' || !RETIRED_RESOURCES[kind]?.includes(name),
  );
  if (unlisted.length)
    throw new Error(
      `Refusing destructive Tinybird deploy; resources absent from retirement manifest: ${unlisted
        .map(([kind, name]) => `${kind ?? 'unknown'}:${name}`)
        .join(', ')}`,
    );
  return drops.length > 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(
    allowDestructiveOperations(deploymentResult(readFileSync(process.argv[2], 'utf8'))) ? '1' : '0',
  );
}
