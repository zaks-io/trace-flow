import {
  IMPORTED_EXECUTION,
  SOURCE_IMPORTED_EXECUTION,
  TRACE_FLOW,
} from '@trace-flow/otel-conventions';
import type { OTLPExportTraceServiceRequest, OTLPKeyValue } from '../types';

export type ImportedScopeSelection =
  | { kind: 'generic' }
  | { kind: 'imported' }
  | { kind: 'invalid'; reason: 'unsupported_version' | 'mixed_scopes' | 'reserved_attribute' };

const reservedKeys = new Set<string>([TRACE_FLOW.IMPORT_IDENTITY, TRACE_FLOW.IMPORT_SOURCE_HASH]);

function hasReservedAttribute(attributes: OTLPKeyValue[] | undefined): boolean {
  return (attributes ?? []).some(
    ({ key, value }) =>
      reservedKeys.has(key) ||
      key.startsWith('trace_flow.import.') ||
      key.startsWith('trace_flow.cost.') ||
      (key === TRACE_FLOW.SOURCE && value.stringValue === SOURCE_IMPORTED_EXECUTION),
  );
}

export function selectImportedScope(
  request: OTLPExportTraceServiceRequest,
): ImportedScopeSelection {
  let imported = false;
  let generic = false;

  for (const resourceSpans of request.resourceSpans) {
    for (const scopeSpans of resourceSpans.scopeSpans) {
      if (scopeSpans.scope?.name === IMPORTED_EXECUTION.SCOPE_NAME) {
        if (scopeSpans.scope.version !== IMPORTED_EXECUTION.SCOPE_VERSION) {
          return { kind: 'invalid', reason: 'unsupported_version' };
        }
        imported = true;
      } else {
        generic = true;
      }
    }
  }

  if (imported && generic) return { kind: 'invalid', reason: 'mixed_scopes' };
  if (imported) return { kind: 'imported' };

  for (const resourceSpans of request.resourceSpans) {
    if (hasReservedAttribute(resourceSpans.resource?.attributes)) {
      return { kind: 'invalid', reason: 'reserved_attribute' };
    }
    for (const scopeSpans of resourceSpans.scopeSpans) {
      if (hasReservedAttribute(scopeSpans.scope?.attributes)) {
        return { kind: 'invalid', reason: 'reserved_attribute' };
      }
      for (const span of scopeSpans.spans) {
        if (
          hasReservedAttribute(span.attributes) ||
          span.events?.some((event) => hasReservedAttribute(event.attributes)) ||
          span.links?.some((link) => hasReservedAttribute(link.attributes))
        ) {
          return { kind: 'invalid', reason: 'reserved_attribute' };
        }
      }
    }
  }
  return { kind: 'generic' };
}
