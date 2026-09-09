import type { AgentIngestEnvelope, AgentIngestQueueMessage } from './agent-ingest';
import { AGENT_INGEST_LIMITS, type FieldSpec } from './agent-ingest-schema';
import {
  BATCH_FIELDS,
  CAPABILITY_FIELDS,
  FILE_FIELDS,
  LEGACY_RAW_MANIFEST_FIELDS,
  MESSAGE_FIELDS,
  PULL_REQUEST_FIELDS,
  QUEUE_FACT_SCHEMAS,
  QUEUE_MESSAGE_FIELDS,
  TENANCY_FIELDS,
  TOOL_FIELDS,
  TRACE_CONTEXT_FIELDS,
} from './agent-ingest-fact-schema';

const encoder = new TextEncoder();
const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pathFor(prefix: string, field: string): string {
  return prefix ? `${prefix}.${field}` : field;
}

function unknownFieldError(
  value: Record<string, unknown>,
  prefix: string,
  fields: Record<string, FieldSpec>,
): string | null {
  for (const key of Object.keys(value)) {
    if (!hasOwn(fields, key)) return pathFor(prefix, key);
  }
  return null;
}

function validNumber(value: unknown, spec: Extract<FieldSpec, { kind: 'number' }>): boolean {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= spec.min &&
    value <= spec.max
  );
}

function validString(value: unknown, maxBytes: number): boolean {
  return typeof value === 'string' && encoder.encode(value).byteLength <= maxBytes;
}

function validateStringArray(
  value: unknown,
  spec: Extract<FieldSpec, { kind: 'stringArray' }>,
): boolean {
  if (!Array.isArray(value) || value.length > spec.maxItems) return false;
  let totalBytes = 0;
  for (const item of value) {
    if (typeof item !== 'string') return false;
    const itemBytes = encoder.encode(item).byteLength;
    if (itemBytes > spec.itemMaxBytes) return false;
    totalBytes += itemBytes;
    if (totalBytes > spec.maxTotalBytes) return false;
  }
  return true;
}

function validateField(value: unknown, spec: FieldSpec): boolean {
  switch (spec.kind) {
    case 'string':
      return validString(value, spec.maxBytes);
    case 'nullableString':
      return value === null || validString(value, spec.maxBytes);
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return value === null ? Boolean(spec.nullable) : validNumber(value, spec);
    case 'enum':
      return typeof value === 'string' && spec.values.includes(value);
    case 'stringArray':
      return validateStringArray(value, spec);
  }
}

export function validateFields(
  value: unknown,
  prefix: string,
  fields: Record<string, FieldSpec>,
  strict = true,
): string | null {
  if (!isRecord(value)) return prefix;
  if (strict) {
    const unknown = unknownFieldError(value, prefix, fields);
    if (unknown) return unknown;
  }
  for (const [field, spec] of Object.entries(fields)) {
    if (!hasOwn(value, field)) {
      if (spec.optional) continue;
      return pathFor(prefix, field);
    }
    if (!validateField(value[field], spec)) return pathFor(prefix, field);
  }
  return null;
}

type FactSchemaMap = Record<string, Record<string, FieldSpec>>;

function validateFactArrays(
  value: unknown,
  prefix: string,
  schemas: FactSchemaMap,
  optionalCategories: readonly string[] = [],
): string | null {
  if (!isRecord(value)) return prefix;
  const unknownKey = Object.keys(value).find((key) => !hasOwn(schemas, key));
  const unknown = unknownKey ? pathFor(prefix, unknownKey) : null;
  if (unknown) return unknown;

  let total = 0;
  for (const category of Object.keys(schemas)) {
    const optional = optionalCategories.includes(category);
    if (!hasOwn(value, category)) {
      if (optional) continue;
      return pathFor(prefix, category);
    }
    const rows = value[category];
    if (!Array.isArray(rows)) return pathFor(prefix, category);
    if (rows.length > AGENT_INGEST_LIMITS.maxFactsPerCategory) {
      return pathFor(prefix, `${category}.length`);
    }
    total += rows.length;
    if (total > AGENT_INGEST_LIMITS.maxFactsTotal) {
      return pathFor(prefix, 'total_count');
    }
    const schema = schemas[category];
    if (!schema) return pathFor(prefix, category);
    for (let index = 0; index < rows.length; index++) {
      const error = validateFields(rows[index], `${prefix}.${category}[${index}]`, schema);
      if (error) return error;
    }
  }
  return null;
}

function validateLegacyRawBundles(value: unknown): string | null {
  if (!Array.isArray(value) || value.length > AGENT_INGEST_LIMITS.maxLegacyRawBundles) {
    return 'raw_session_bundles';
  }
  for (let index = 0; index < value.length; index++) {
    const bundle: unknown = value[index];
    const bundlePath = `raw_session_bundles[${index}]`;
    if (!isRecord(bundle)) return bundlePath;
    const unknownBundleField = Object.keys(bundle).find(
      (key) => key !== 'manifest' && key !== 'gzip_base64',
    );
    if (unknownBundleField) return pathFor(bundlePath, unknownBundleField);
    if (!hasOwn(bundle, 'manifest')) return pathFor(bundlePath, 'manifest');
    const manifestError = validateFields(
      bundle.manifest,
      pathFor(bundlePath, 'manifest'),
      LEGACY_RAW_MANIFEST_FIELDS,
    );
    if (manifestError) return manifestError;
    if (!hasOwn(bundle, 'gzip_base64')) return pathFor(bundlePath, 'gzip_base64');
    if (!validString(bundle.gzip_base64, AGENT_INGEST_LIMITS.maxLegacyRawGzipBytes)) {
      return pathFor(bundlePath, 'gzip_base64');
    }
  }
  return null;
}

/** Full runtime validation for the HTTP Collector -> Agent Ingest contract. */
export function validateAgentIngestEnvelope(value: unknown): string | null {
  if (!isRecord(value)) return 'envelope';
  const unknown = Object.keys(value).find(
    (key) => key !== 'batch' && key !== 'facts' && key !== 'raw_session_bundles',
  );
  if (unknown) return unknown;

  const batchError = validateFields(value.batch, 'batch', BATCH_FIELDS);
  if (batchError) return batchError;
  const factsError = validateFactArrays(value.facts, 'facts', {
    messages: MESSAGE_FIELDS,
    tool_events: TOOL_FIELDS,
    file_events: FILE_FIELDS,
    capability_snapshots: CAPABILITY_FIELDS,
    pull_request_links: PULL_REQUEST_FIELDS,
  });
  if (factsError) return factsError;
  if (hasOwn(value, 'raw_session_bundles')) {
    const legacyError = validateLegacyRawBundles(value.raw_session_bundles);
    if (legacyError) return legacyError;
  }
  return null;
}

function validateTraceContext(value: unknown): string | null {
  return validateFields(value, 'sentry_trace_context', TRACE_CONTEXT_FIELDS);
}

/** Full runtime validation for the Worker -> Queue -> Agent Consumer contract. */
export function validateAgentIngestQueueMessage(value: unknown): string | null {
  if (!isRecord(value)) return 'queue_message';
  const unknown = Object.keys(value).find(
    (key) =>
      key !== 'type' &&
      key !== 'source' &&
      key !== 'parser_version' &&
      key !== 'desktop_version' &&
      key !== 'collector_batch_id' &&
      key !== 'tenancy' &&
      key !== 'facts' &&
      key !== 'enqueued_at' &&
      key !== 'sentry_trace_context',
  );
  if (unknown) return unknown;

  const scalarError = validateFields(value, 'queue_message', QUEUE_MESSAGE_FIELDS, false);
  if (scalarError) return scalarError;
  const tenancyError = validateFields(value.tenancy, 'queue_message.tenancy', TENANCY_FIELDS);
  if (tenancyError) return tenancyError;
  const factsError = validateFactArrays(value.facts, 'queue_message.facts', QUEUE_FACT_SCHEMAS, [
    'review_unit_attributions',
  ]);
  if (factsError) return factsError;
  if (hasOwn(value, 'sentry_trace_context')) {
    const traceError = validateTraceContext(value.sentry_trace_context);
    if (traceError) return traceError;
  }
  return null;
}

export function isAgentIngestEnvelope(value: unknown): value is AgentIngestEnvelope {
  return validateAgentIngestEnvelope(value) === null;
}

export function isAgentIngestQueueMessage(value: unknown): value is AgentIngestQueueMessage {
  return validateAgentIngestQueueMessage(value) === null;
}
