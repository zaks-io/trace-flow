import { CLI_PROXY, IMPORTED_CLIENT_SOURCES } from '@trace-flow/otel-conventions';

export function validateImportedClientIdentity(
  attributes: Record<string, string>,
): string | undefined {
  const source = attributes[CLI_PROXY.CLIENT_SOURCE];
  const session = attributes[CLI_PROXY.CLIENT_SESSION_ID];
  const agent = attributes[CLI_PROXY.CLIENT_AGENT_ID];
  const parent = attributes[CLI_PROXY.CLIENT_PARENT_SESSION_ID];
  const origin = attributes[CLI_PROXY.CLIENT_ORIGIN_SESSION_ID];
  const trace = attributes[CLI_PROXY.INBOUND_TRACE_ID];
  const span = attributes[CLI_PROXY.INBOUND_SPAN_ID];

  if ((source === undefined) !== (session === undefined)) return 'attribute_client_session';
  if (source !== undefined && !IMPORTED_CLIENT_SOURCES.some((value) => value === source)) {
    return 'attribute_client_source';
  }
  if (agent !== undefined && (source !== 'claude' || session === undefined || agent === 'main')) {
    return 'attribute_client_agent';
  }
  if (parent !== undefined && (source !== 'codex' || session === undefined || parent === session)) {
    return 'attribute_client_parent';
  }
  if (origin !== undefined && (source !== 'codex' || session === undefined || origin === session)) {
    return 'attribute_client_origin';
  }
  if ((trace === undefined) !== (span === undefined)) return 'attribute_inbound_trace';
  return undefined;
}
