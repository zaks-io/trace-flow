import type { OTLPAnyValue, OTLPExportTraceServiceRequest, OTLPKeyValue } from './types';
import { OTLP_LIMITS } from './limits';

const ESTIMATED_FIXED_BYTES_PER_TRACE = 2_048;

/**
 * The transformed traces are serialized into an R2 delivery envelope before this Worker responds.
 * Keeping the projected envelope at or below the request cap prevents shared resource attributes
 * from expanding a small OTLP export into an isolate-sized allocation.
 */
const MAX_TRANSFORMED_TRACE_BYTES = OTLP_LIMITS.transformedTraceBytes;

export interface ValidationResult {
  valid: boolean;
  error?: string;
  status?: 400 | 413;
}

const encoder = new TextEncoder();
const byteLength = (value: string): number => encoder.encode(value).length;
const jsonByteLength = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;

function invalid(error: string): ValidationResult {
  return { valid: false, error, status: 400 };
}

function tooLarge(error: string): ValidationResult {
  return { valid: false, error, status: 413 };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateBoundedString(
  value: unknown,
  label: string,
  maxBytes: number,
  required = false,
): ValidationResult | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || (required && value.length === 0)) {
    return invalid(`${label} ${required ? 'is required and ' : ''}must be a string`);
  }
  if (byteLength(value) > maxBytes) {
    return tooLarge(`${label} exceeds the ${maxBytes}-byte limit`);
  }
  return undefined;
}

function validateAnyValue(
  value: unknown,
  label: string,
  depth: number,
): ValidationResult | undefined {
  if (!isObject(value)) return invalid(`${label} must be an object`);
  if (depth > OTLP_LIMITS.attributeDepth) {
    return tooLarge(`${label} exceeds the maximum nesting depth`);
  }

  const anyValue = value as OTLPAnyValue;
  for (const key of ['stringValue', 'bytesValue'] as const) {
    if (anyValue[key] !== undefined) {
      const error = validateBoundedString(anyValue[key], `${label}.${key}`, OTLP_LIMITS.valueBytes);
      if (error) return error;
    }
  }
  if (anyValue.intValue !== undefined) {
    let normalized: string;
    if (typeof anyValue.intValue === 'number') {
      if (!Number.isSafeInteger(anyValue.intValue)) {
        return invalid(`${label}.intValue must be a safe integer or decimal string`);
      }
      normalized = String(anyValue.intValue);
    } else if (typeof anyValue.intValue === 'string') {
      normalized = anyValue.intValue;
    } else {
      return invalid(`${label}.intValue must be a safe integer or decimal string`);
    }

    const sizeError = validateBoundedString(
      normalized,
      `${label}.intValue`,
      OTLP_LIMITS.valueBytes,
    );
    if (sizeError) return sizeError;
    if (!/^-?\d+$/.test(normalized)) {
      return invalid(`${label}.intValue must be an integer`);
    }
    const negative = normalized.startsWith('-');
    const digits = negative ? normalized.slice(1) : normalized;
    const magnitude = digits.replace(/^0+/, '') || '0';
    if (magnitude.length > 19) return invalid(`${label}.intValue is outside the int64 range`);
    const parsed = BigInt(`${negative ? '-' : ''}${magnitude}`);
    if (parsed < -(1n << 63n) || parsed > (1n << 63n) - 1n) {
      return invalid(`${label}.intValue is outside the int64 range`);
    }
    anyValue.intValue = normalized;
  }
  if (anyValue.boolValue !== undefined && typeof anyValue.boolValue !== 'boolean') {
    return invalid(`${label}.boolValue must be a boolean`);
  }
  if (
    anyValue.doubleValue !== undefined &&
    (typeof anyValue.doubleValue !== 'number' || !Number.isFinite(anyValue.doubleValue))
  ) {
    return invalid(`${label}.doubleValue must be a finite number`);
  }
  if (anyValue.arrayValue !== undefined) {
    if (!isObject(anyValue.arrayValue) || !Array.isArray(anyValue.arrayValue.values)) {
      return invalid(`${label}.arrayValue.values must be an array`);
    }
    if (anyValue.arrayValue.values.length > OTLP_LIMITS.nestedValues) {
      return tooLarge(`${label}.arrayValue exceeds the ${OTLP_LIMITS.nestedValues}-value limit`);
    }
    for (const [index, nested] of anyValue.arrayValue.values.entries()) {
      const error = validateAnyValue(nested, `${label}.arrayValue.values[${index}]`, depth + 1);
      if (error) return error;
    }
  }
  if (anyValue.kvlistValue !== undefined) {
    if (!isObject(anyValue.kvlistValue) || !Array.isArray(anyValue.kvlistValue.values)) {
      return invalid(`${label}.kvlistValue.values must be an array`);
    }
    const error = validateAttributes(
      anyValue.kvlistValue.values,
      `${label}.kvlistValue.values`,
      depth + 1,
      OTLP_LIMITS.nestedValues,
    );
    if (error) return error;
  }
  return undefined;
}

function validateAttributes(
  attributes: unknown,
  label: string,
  depth = 0,
  maxAttributes = OTLP_LIMITS.attributes,
): ValidationResult | undefined {
  if (attributes === undefined) return undefined;
  if (!Array.isArray(attributes)) return invalid(`${label} must be an array`);
  if (attributes.length > maxAttributes) {
    return tooLarge(`${label} exceeds the ${maxAttributes}-attribute limit`);
  }

  for (const [index, attribute] of attributes.entries()) {
    if (!isObject(attribute)) return invalid(`${label}[${index}] must be an object`);
    const keyError = validateBoundedString(
      (attribute as unknown as OTLPKeyValue).key,
      `${label}[${index}].key`,
      OTLP_LIMITS.keyBytes,
      true,
    );
    if (keyError) return keyError;
    const valueError = validateAnyValue(
      (attribute as unknown as OTLPKeyValue).value,
      `${label}[${index}].value`,
      depth,
    );
    if (valueError) return valueError;
  }
  return undefined;
}

const UINT64_MAX = (1n << 64n) - 1n;

function normalizedUint64(value: unknown): string | undefined {
  const normalized =
    typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof normalized !== 'string' || !/^\d{1,20}$/.test(normalized)) return undefined;
  return BigInt(normalized) <= UINT64_MAX ? normalized : undefined;
}

function validateSpan(span: unknown, spanIndex: number): ValidationResult | undefined {
  if (!isObject(span)) return invalid(`Span ${spanIndex} must be an object`);

  for (const [field, limit] of [
    ['traceId', OTLP_LIMITS.keyBytes],
    ['spanId', OTLP_LIMITS.keyBytes],
    ['name', OTLP_LIMITS.nameBytes],
  ] as const) {
    const error = validateBoundedString(span[field], `Span ${spanIndex}: ${field}`, limit, true);
    if (error) return error;
  }
  for (const field of ['parentSpanId', 'traceState'] as const) {
    const error = validateBoundedString(
      span[field],
      `Span ${spanIndex}: ${field}`,
      OTLP_LIMITS.keyBytes,
    );
    if (error) return error;
  }

  for (const field of ['startTimeUnixNano', 'endTimeUnixNano'] as const) {
    const normalized = normalizedUint64(span[field]);
    if (normalized === undefined) {
      return invalid(`Span ${spanIndex}: ${field} must be a uint64 nanosecond value`);
    }
    span[field] = normalized;
  }

  const attributeError = validateAttributes(span.attributes, `Span ${spanIndex}: attributes`);
  if (attributeError) return attributeError;

  if (span.status !== undefined) {
    if (!isObject(span.status)) return invalid(`Span ${spanIndex}: status must be an object`);
    const messageError = validateBoundedString(
      span.status.message,
      `Span ${spanIndex}: status.message`,
      OTLP_LIMITS.valueBytes,
    );
    if (messageError) return messageError;
    if (
      span.status.code !== undefined &&
      (typeof span.status.code !== 'number' || !Number.isInteger(span.status.code))
    ) {
      return invalid(`Span ${spanIndex}: status.code must be an integer`);
    }
  }

  if (span.events !== undefined) {
    if (!Array.isArray(span.events)) return invalid(`Span ${spanIndex}: events must be an array`);
    if (span.events.length > OTLP_LIMITS.events) {
      return tooLarge(`Span ${spanIndex}: events exceeds the ${OTLP_LIMITS.events}-event limit`);
    }
    for (const [eventIndex, event] of span.events.entries()) {
      if (!isObject(event))
        return invalid(`Span ${spanIndex}: event ${eventIndex} must be an object`);
      const nameError = validateBoundedString(
        event.name,
        `Span ${spanIndex}: event ${eventIndex} name`,
        OTLP_LIMITS.nameBytes,
        true,
      );
      if (nameError) return nameError;
      if (event.timeUnixNano !== undefined) {
        const normalized = normalizedUint64(event.timeUnixNano);
        if (normalized === undefined) {
          return invalid(`Span ${spanIndex}: event ${eventIndex} time must be a uint64 value`);
        }
        event.timeUnixNano = normalized;
      }
      const eventAttributeError = validateAttributes(
        event.attributes,
        `Span ${spanIndex}: event ${eventIndex} attributes`,
      );
      if (eventAttributeError) return eventAttributeError;
    }
  }

  if (span.links !== undefined) {
    if (!Array.isArray(span.links)) return invalid(`Span ${spanIndex}: links must be an array`);
    if (span.links.length > OTLP_LIMITS.links) {
      return tooLarge(`Span ${spanIndex}: links exceeds the ${OTLP_LIMITS.links}-link limit`);
    }
    for (const [linkIndex, link] of span.links.entries()) {
      if (!isObject(link)) return invalid(`Span ${spanIndex}: link ${linkIndex} must be an object`);
      for (const field of ['traceId', 'spanId'] as const) {
        const idError = validateBoundedString(
          link[field],
          `Span ${spanIndex}: link ${linkIndex} ${field}`,
          OTLP_LIMITS.keyBytes,
          true,
        );
        if (idError) return idError;
      }
      const traceStateError = validateBoundedString(
        link.traceState,
        `Span ${spanIndex}: link ${linkIndex} traceState`,
        OTLP_LIMITS.keyBytes,
      );
      if (traceStateError) return traceStateError;
      const linkAttributeError = validateAttributes(
        link.attributes,
        `Span ${spanIndex}: link ${linkIndex} attributes`,
      );
      if (linkAttributeError) return linkAttributeError;
    }
  }

  return undefined;
}

export function validateOTLPRequest(request: unknown): ValidationResult {
  if (!isObject(request)) return invalid('Request body must be an object');
  const req = request as unknown as OTLPExportTraceServiceRequest;
  if (!Array.isArray(req.resourceSpans)) return invalid('resourceSpans must be an array');
  if (req.resourceSpans.length > OTLP_LIMITS.resourceSpans) {
    return tooLarge(`resourceSpans exceeds the ${OTLP_LIMITS.resourceSpans}-item limit`);
  }

  let scopeSpanCount = 0;
  let spanCount = 0;
  let projectedBytes = 0;

  for (const [resourceIndex, resourceSpan] of req.resourceSpans.entries()) {
    if (!isObject(resourceSpan))
      return invalid(`resourceSpans[${resourceIndex}] must be an object`);
    if (resourceSpan.resource !== undefined && !isObject(resourceSpan.resource)) {
      return invalid(`resourceSpans[${resourceIndex}].resource must be an object`);
    }
    const resourceAttributes = resourceSpan.resource?.attributes;
    const resourceError = validateAttributes(
      resourceAttributes,
      `resourceSpans[${resourceIndex}].resource.attributes`,
    );
    if (resourceError) return resourceError;
    if (!Array.isArray(resourceSpan.scopeSpans)) {
      return invalid(`resourceSpans[${resourceIndex}].scopeSpans must be an array`);
    }

    scopeSpanCount += resourceSpan.scopeSpans.length;
    if (scopeSpanCount > OTLP_LIMITS.scopeSpans) {
      return tooLarge(`scopeSpans exceeds the ${OTLP_LIMITS.scopeSpans}-item limit`);
    }
    const resourceBytes = resourceAttributes ? jsonByteLength(resourceAttributes) : 0;

    for (const [scopeIndex, scopeSpan] of resourceSpan.scopeSpans.entries()) {
      if (!isObject(scopeSpan)) {
        return invalid(
          `resourceSpans[${resourceIndex}].scopeSpans[${scopeIndex}] must be an object`,
        );
      }
      if (scopeSpan.scope !== undefined && !isObject(scopeSpan.scope)) {
        return invalid(
          `resourceSpans[${resourceIndex}].scopeSpans[${scopeIndex}].scope must be an object`,
        );
      }
      for (const field of ['name', 'version'] as const) {
        const scopeFieldError = validateBoundedString(
          scopeSpan.scope?.[field],
          `resourceSpans[${resourceIndex}].scopeSpans[${scopeIndex}].scope.${field}`,
          OTLP_LIMITS.nameBytes,
        );
        if (scopeFieldError) return scopeFieldError;
      }
      const scopeAttributeError = validateAttributes(
        scopeSpan.scope?.attributes,
        `resourceSpans[${resourceIndex}].scopeSpans[${scopeIndex}].scope.attributes`,
      );
      if (scopeAttributeError) return scopeAttributeError;
      if (!Array.isArray(scopeSpan.spans)) {
        return invalid(
          `resourceSpans[${resourceIndex}].scopeSpans[${scopeIndex}].spans must be an array`,
        );
      }

      for (const span of scopeSpan.spans) {
        spanCount += 1;
        if (spanCount > OTLP_LIMITS.spans) {
          return tooLarge(`spans exceeds the ${OTLP_LIMITS.spans}-item limit`);
        }
        const spanError = validateSpan(span, spanCount);
        if (spanError) return spanError;

        projectedBytes +=
          ESTIMATED_FIXED_BYTES_PER_TRACE +
          resourceBytes * 2 +
          jsonByteLength([
            span.traceId,
            span.spanId,
            span.parentSpanId,
            span.traceState,
            span.name,
            span.startTimeUnixNano,
            span.endTimeUnixNano,
            span.status,
          ]) +
          jsonByteLength(span.attributes ?? []) +
          jsonByteLength(span.events ?? []) +
          jsonByteLength(span.links ?? []);
        if (projectedBytes > MAX_TRANSFORMED_TRACE_BYTES) {
          return tooLarge(
            `Transformed trace payload exceeds the ${MAX_TRANSFORMED_TRACE_BYTES}-byte limit`,
          );
        }
      }
    }
  }

  return { valid: true };
}
