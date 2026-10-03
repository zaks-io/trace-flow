import {
  CLI_PROXY,
  GEN_AI,
  GEN_AI_USAGE,
  HTTP,
  IMPORTED_ACCOUNT_COVERAGE,
  IMPORTED_EXECUTION,
} from '@trace-flow/otel-conventions';
import type {
  OTLPAnyValue,
  OTLPExportTraceServiceRequest,
  OTLPKeyValue,
  OTLPResource,
  OTLPSpan,
} from '../types';
import { validateImportedClientIdentity } from './clientIdentity';
import { validateImportedTokenUsage } from './tokenUsage';

export interface ImportedExecutionInput {
  installationId: string;
  executionId: string;
  resource: OTLPResource;
  span: OTLPSpan;
  attributes: Record<string, string>;
}

export type ImportedValidation =
  | { valid: true; executions: ImportedExecutionInput[] }
  | { valid: false; reason: string; spanIndex: number };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACCOUNT_REF_PATTERN = /^[0-9a-f]{64}$/;
const TRACE_ID_PATTERN = /^(?!0{32}$)[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^(?!0{16}$)[0-9a-f]{16}$/;
const TOKEN_64_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const TOKEN_128_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const TOKEN_32_PATTERN = /^[A-Za-z0-9._:-]{1,32}$/;
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const RESOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/;
const SECRET_PATTERN =
  /(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|eyJ[A-Za-z0-9_-]{30,})/;
const MAX_SPAN_ATTRIBUTES = 32;
const MAX_STORED_TIMESTAMP_NS = (1n << 63n) - 1n;

const RESOURCE_KEYS = new Set<string>([
  CLI_PROXY.INSTALLATION_ID,
  'service.name',
  'service.version',
  'service.instance.id',
  'telemetry.sdk.name',
  'telemetry.sdk.language',
  'telemetry.sdk.version',
]);
const STRING_PATTERNS: Record<string, RegExp> = {
  [CLI_PROXY.EXECUTION_ID]: UUID_PATTERN,
  [CLI_PROXY.INBOUND_REQUEST_ID]: TOKEN_64_PATTERN,
  [GEN_AI.SYSTEM]: PROVIDER_PATTERN,
  [GEN_AI.REQUEST_MODEL]: MODEL_PATTERN,
  [CLI_PROXY.REQUEST_MODEL_ALIAS]: MODEL_PATTERN,
  [GEN_AI.RESPONSE_MODEL]: MODEL_PATTERN,
  [CLI_PROXY.REQUEST_SERVICE_TIER]: TOKEN_32_PATTERN,
  [CLI_PROXY.RESPONSE_SERVICE_TIER]: TOKEN_32_PATTERN,
  [CLI_PROXY.ACCOUNT_REF]: ACCOUNT_REF_PATTERN,
  [CLI_PROXY.SESSION_ID]: TOKEN_128_PATTERN,
  [CLI_PROXY.CLIENT_SOURCE]: /^(claude|codex)$/,
  [CLI_PROXY.CLIENT_SESSION_ID]: TOKEN_128_PATTERN,
  [CLI_PROXY.CLIENT_AGENT_ID]: TOKEN_128_PATTERN,
  [CLI_PROXY.CLIENT_PARENT_SESSION_ID]: TOKEN_128_PATTERN,
  [CLI_PROXY.CLIENT_ORIGIN_SESSION_ID]: TOKEN_128_PATTERN,
  [CLI_PROXY.INBOUND_TRACE_ID]: TRACE_ID_PATTERN,
  [CLI_PROXY.INBOUND_SPAN_ID]: SPAN_ID_PATTERN,
  [CLI_PROXY.PARENT_SESSION_ID]: TOKEN_128_PATTERN,
  [GEN_AI_USAGE.QUALITY]: /^(complete|inconsistent|unclassified)$/,
};
const INTEGER_KEYS = new Set<string>([
  GEN_AI_USAGE.SCHEMA_VERSION,
  GEN_AI_USAGE.TOTAL_TOKENS,
  GEN_AI_USAGE.INPUT_TOKENS,
  GEN_AI_USAGE.INPUT_TOKENS_UNCACHED,
  GEN_AI_USAGE.CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE.CACHE_CREATION_INPUT_TOKENS,
  GEN_AI_USAGE.OUTPUT_TOKENS,
  GEN_AI_USAGE.OUTPUT_TOKENS_NON_REASONING,
  GEN_AI_USAGE.REASONING_TOKENS,
  GEN_AI_USAGE.UNCLASSIFIED_TOKENS,
  GEN_AI.SERVER_TTFT,
  HTTP.RESPONSE_STATUS_CODE,
]);
const BOOLEAN_KEYS = new Set<string>([GEN_AI.STREAMING, GEN_AI_USAGE.MISSING]);
const SPAN_KEYS = new Set<string>([
  ...Object.keys(STRING_PATTERNS),
  ...INTEGER_KEYS,
  ...BOOLEAN_KEYS,
  CLI_PROXY.ACCOUNT_COVERAGE,
]);

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function invalid(reason: string, spanIndex: number): ImportedValidation {
  return { valid: false, reason, spanIndex };
}

function normalizeUuid(value: string): string | undefined {
  const normalized = value.toLowerCase();
  if (
    !UUID_PATTERN.test(normalized) ||
    normalized === '00000000-0000-0000-0000-000000000000' ||
    normalized === 'ffffffff-ffff-ffff-ffff-ffffffffffff'
  ) {
    return undefined;
  }
  return normalized;
}

function extractAttributes(
  attributes: OTLPKeyValue[] | undefined,
  allowed: Set<string>,
): { values: Record<string, string> } | { reason: string } {
  const values: Record<string, string> = {};
  for (const attribute of attributes ?? []) {
    if (!hasOnlyKeys(attribute, ['key', 'value']) || !allowed.has(attribute.key)) {
      return { reason: 'attribute_not_allowed' };
    }
    if (Object.hasOwn(values, attribute.key)) return { reason: 'attribute_duplicate' };
    const value: OTLPAnyValue = attribute.value;
    const kinds = Object.keys(value);
    if (kinds.length !== 1) return { reason: 'attribute_value_type' };
    const kind = kinds[0];
    let normalized: string;
    if (kind === 'stringValue' && typeof value.stringValue === 'string') {
      normalized = value.stringValue;
      if (EMAIL_PATTERN.test(normalized)) return { reason: 'attribute_email' };
      if (SECRET_PATTERN.test(normalized)) return { reason: 'attribute_sensitive' };
      if (attribute.key === CLI_PROXY.INSTALLATION_ID || attribute.key === CLI_PROXY.EXECUTION_ID) {
        const uuid = normalizeUuid(normalized);
        if (!uuid) return { reason: 'attribute_uuid' };
        normalized = uuid;
      } else if (attribute.key === CLI_PROXY.ACCOUNT_COVERAGE) {
        if (!IMPORTED_ACCOUNT_COVERAGE.some((coverage) => coverage === normalized)) {
          return { reason: 'account_coverage' };
        }
      } else if (allowed === RESOURCE_KEYS) {
        if (!RESOURCE_PATTERN.test(normalized)) return { reason: 'resource_value' };
      } else if (!STRING_PATTERNS[attribute.key]?.test(normalized)) {
        return { reason: 'attribute_string' };
      }
    } else if (kind === 'intValue' && INTEGER_KEYS.has(attribute.key)) {
      normalized = String(value.intValue);
      if (!/^[0-9]+$/.test(normalized)) return { reason: 'attribute_integer' };
      normalized = BigInt(normalized).toString();
    } else if (
      kind === 'boolValue' &&
      BOOLEAN_KEYS.has(attribute.key) &&
      typeof value.boolValue === 'boolean'
    ) {
      normalized = String(value.boolValue);
    } else {
      return { reason: 'attribute_value_type' };
    }
    values[attribute.key] = normalized;
  }
  return { values };
}

function validateSpan(
  span: OTLPSpan,
  resource: OTLPResource,
  installationId: string,
  spanIndex: number,
): ImportedValidation {
  if (
    !hasOnlyKeys(span, [
      'traceId',
      'spanId',
      'name',
      'kind',
      'startTimeUnixNano',
      'endTimeUnixNano',
      'status',
      'attributes',
      'parentSpanId',
      'traceState',
      'flags',
      'events',
      'links',
      'droppedAttributesCount',
      'droppedEventsCount',
      'droppedLinksCount',
    ]) ||
    !hasOnlyKeys(span.status ?? {}, ['code', 'message']) ||
    span.kind !== 2 ||
    span.parentSpanId !== undefined ||
    span.traceState !== undefined ||
    span.flags !== undefined ||
    span.events !== undefined ||
    span.links !== undefined ||
    span.droppedAttributesCount ||
    span.droppedEventsCount ||
    span.droppedLinksCount
  ) {
    return invalid('span_shape', spanIndex);
  }
  if (!span.status || ![1, 2].includes(span.status.code ?? 0) || span.status.message) {
    return invalid('status', spanIndex);
  }
  const start = BigInt(span.startTimeUnixNano);
  const end = BigInt(span.endTimeUnixNano);
  if (
    start <= 0n ||
    end > MAX_STORED_TIMESTAMP_NS ||
    BigInt(Number(end)) > MAX_STORED_TIMESTAMP_NS ||
    end < start ||
    end - start > IMPORTED_EXECUTION.MAX_DURATION_NS
  ) {
    return invalid('timing', spanIndex);
  }
  if ((span.attributes?.length ?? 0) > MAX_SPAN_ATTRIBUTES) {
    return invalid('attribute_count', spanIndex);
  }
  const extracted = extractAttributes(span.attributes, SPAN_KEYS);
  if ('reason' in extracted) return invalid(extracted.reason, spanIndex);
  const attributes = extracted.values;
  const executionId = attributes[CLI_PROXY.EXECUTION_ID];
  const provider = attributes[GEN_AI.SYSTEM];
  const model = attributes[GEN_AI.REQUEST_MODEL];
  const coverage = attributes[CLI_PROXY.ACCOUNT_COVERAGE];
  if (!executionId || !provider || !model || !coverage)
    return invalid('required_attribute', spanIndex);
  const executionHex = executionId.replaceAll('-', '');
  if (
    span.traceId.toLowerCase() !== executionHex ||
    span.spanId.toLowerCase() !== executionHex.slice(16)
  ) {
    return invalid('otel_identity', spanIndex);
  }
  if (span.name !== model) {
    return invalid('span_name', spanIndex);
  }
  if (
    coverage === 'unknown'
      ? attributes[CLI_PROXY.ACCOUNT_REF] !== undefined
      : !attributes[CLI_PROXY.ACCOUNT_REF]
  ) {
    return invalid('account_ref', spanIndex);
  }
  const clientError = validateImportedClientIdentity(attributes);
  if (clientError) return invalid(clientError, spanIndex);
  const usageError = validateImportedTokenUsage(attributes);
  if (usageError) return invalid(usageError, spanIndex);
  const ttft = attributes[GEN_AI.SERVER_TTFT];
  if (ttft !== undefined && Number(ttft) * 1_000_000 > Number(end - start)) {
    return invalid('ttft_range', spanIndex);
  }
  const statusCode = attributes[HTTP.RESPONSE_STATUS_CODE];
  if (statusCode !== undefined && (Number(statusCode) < 100 || Number(statusCode) > 599)) {
    return invalid('http_status_range', spanIndex);
  }
  return {
    valid: true,
    executions: [{ installationId, executionId, resource, span, attributes }],
  };
}

export function validateImportedExecutionRequest(
  request: OTLPExportTraceServiceRequest,
): ImportedValidation {
  if (!hasOnlyKeys(request, ['resourceSpans'])) return invalid('request_shape', 0);
  const executions: ImportedExecutionInput[] = [];
  const identities = new Set<string>();
  const otelIds = new Set<string>();
  let spanIndex = 0;

  for (const resourceSpans of request.resourceSpans) {
    if (!hasOnlyKeys(resourceSpans, ['resource', 'scopeSpans'])) {
      return invalid('resource_shape', spanIndex);
    }
    if (resourceSpans.resource?.droppedAttributesCount)
      return invalid('resource_dropped', spanIndex);
    const resource = resourceSpans.resource;
    if (!resource) return invalid('resource_missing', spanIndex);
    if (!hasOnlyKeys(resource, ['attributes', 'droppedAttributesCount'])) {
      return invalid('resource_shape', spanIndex);
    }
    const extracted = extractAttributes(resource.attributes, RESOURCE_KEYS);
    if ('reason' in extracted) return invalid(extracted.reason, spanIndex);
    const installationId = extracted.values[CLI_PROXY.INSTALLATION_ID];
    if (!installationId || !extracted.values['service.name']) {
      return invalid('resource_required', spanIndex);
    }
    for (const scopeSpans of resourceSpans.scopeSpans) {
      if (
        !hasOnlyKeys(scopeSpans, ['scope', 'spans']) ||
        !scopeSpans.scope ||
        !hasOnlyKeys(scopeSpans.scope, ['name', 'version', 'attributes', 'droppedAttributesCount'])
      ) {
        return invalid('scope_shape', spanIndex);
      }
      if (scopeSpans.scope?.attributes?.length || scopeSpans.scope?.droppedAttributesCount) {
        return invalid('scope_attributes', spanIndex);
      }
      for (const span of scopeSpans.spans) {
        spanIndex++;
        const result = validateSpan(span, resource, installationId, spanIndex);
        if (!result.valid) return result;
        const execution = result.executions[0]!;
        const identity = `${installationId}\0${execution.executionId}`;
        const otelIdentity = `${span.traceId.toLowerCase()}\0${span.spanId.toLowerCase()}`;
        if (identities.has(identity) || otelIds.has(otelIdentity)) {
          return invalid('duplicate_execution', spanIndex);
        }
        identities.add(identity);
        otelIds.add(otelIdentity);
        executions.push(execution);
      }
    }
  }
  if (executions.length === 0) return invalid('execution_missing', 0);
  return { valid: true, executions };
}
