import type { OTLPAnyValue, OTLPExportTraceServiceRequest, OTLPKeyValue } from './types';

const MAX_RESOURCE_SPANS = 1_024;
const MAX_SCOPE_SPANS = 4_096;
const MAX_SPANS = 5_000;
const MAX_ATTRIBUTES = 256;
const MAX_EVENTS = 256;
const MAX_LINKS = 256;
const MAX_NESTED_VALUES = 256;
const MAX_ATTRIBUTE_DEPTH = 8;
const MAX_KEY_BYTES = 1_024;
const MAX_NAME_BYTES = 64 * 1_024;
const MAX_VALUE_BYTES = 256 * 1_024;
const ESTIMATED_FIXED_BYTES_PER_TRACE = 2_048;

/**
 * The transformed traces are serialized into an R2 delivery envelope before this Worker responds.
 * Keeping the projected envelope at or below the request cap prevents shared resource attributes
 * from expanding a small OTLP export into an isolate-sized allocation.
 */
const MAX_TRANSFORMED_TRACE_BYTES = 10 * 1_024 * 1_024;

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
  if (depth > MAX_ATTRIBUTE_DEPTH) {
    return tooLarge(`${label} exceeds the maximum nesting depth`);
  }

  const anyValue = value as OTLPAnyValue;
  for (const key of ['stringValue', 'bytesValue'] as const) {
    if (anyValue[key] !== undefined) {
      const error = validateBoundedString(anyValue[key], `${label}.${key}`, MAX_VALUE_BYTES);
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

    const sizeError = validateBoundedString(normalized, `${label}.intValue`, MAX_VALUE_BYTES);
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
    if (anyValue.arrayValue.values.length > MAX_NESTED_VALUES) {
      return tooLarge(`${label}.arrayValue exceeds the ${MAX_NESTED_VALUES}-value limit`);
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
      MAX_NESTED_VALUES,
    );
    if (error) return error;
  }
  return undefined;
}

function validateAttributes(
  attributes: unknown,
  label: string,
  depth = 0,
  maxAttributes = MAX_ATTRIBUTES,
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
      MAX_KEY_BYTES,
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
    ['traceId', MAX_KEY_BYTES],
    ['spanId', MAX_KEY_BYTES],
    ['name', MAX_NAME_BYTES],
  ] as const) {
    const error = validateBoundedString(span[field], `Span ${spanIndex}: ${field}`, limit, true);
    if (error) return error;
  }
  for (const field of ['parentSpanId', 'traceState'] as const) {
    const error = validateBoundedString(span[field], `Span ${spanIndex}: ${field}`, MAX_KEY_BYTES);
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
      MAX_VALUE_BYTES,
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
    if (span.events.length > MAX_EVENTS) {
      return tooLarge(`Span ${spanIndex}: events exceeds the ${MAX_EVENTS}-event limit`);
    }
    for (const [eventIndex, event] of span.events.entries()) {
      if (!isObject(event))
        return invalid(`Span ${spanIndex}: event ${eventIndex} must be an object`);
      const nameError = validateBoundedString(
        event.name,
        `Span ${spanIndex}: event ${eventIndex} name`,
        MAX_NAME_BYTES,
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
    if (span.links.length > MAX_LINKS) {
      return tooLarge(`Span ${spanIndex}: links exceeds the ${MAX_LINKS}-link limit`);
    }
    for (const [linkIndex, link] of span.links.entries()) {
      if (!isObject(link)) return invalid(`Span ${spanIndex}: link ${linkIndex} must be an object`);
      for (const field of ['traceId', 'spanId'] as const) {
        const idError = validateBoundedString(
          link[field],
          `Span ${spanIndex}: link ${linkIndex} ${field}`,
          MAX_KEY_BYTES,
          true,
        );
        if (idError) return idError;
      }
      const traceStateError = validateBoundedString(
        link.traceState,
        `Span ${spanIndex}: link ${linkIndex} traceState`,
        MAX_KEY_BYTES,
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
  if (req.resourceSpans.length > MAX_RESOURCE_SPANS) {
    return tooLarge(`resourceSpans exceeds the ${MAX_RESOURCE_SPANS}-item limit`);
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
    if (scopeSpanCount > MAX_SCOPE_SPANS) {
      return tooLarge(`scopeSpans exceeds the ${MAX_SCOPE_SPANS}-item limit`);
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
          MAX_NAME_BYTES,
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
        if (spanCount > MAX_SPANS) return tooLarge(`spans exceeds the ${MAX_SPANS}-item limit`);
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
