import { Reader, WIRE_FIXED64, WIRE_LEN, WIRE_VARINT, WireReadError } from './wire';
import type {
  OTLPAnyValue,
  OTLPExportTraceServiceRequest,
  OTLPKeyValue,
  OTLPResource,
  OTLPResourceSpans,
  OTLPSpan,
  OTLPSpanEvent,
  OTLPSpanLink,
  OTLPStatus,
} from './types';

/**
 * Decodes OTLP/HTTP protobuf payloads (opentelemetry.proto.trace.v1.ExportTraceServiceRequest)
 * into the same JSON-shaped object used by the JSON handler, so the existing
 * validation and transform pipeline can consume either encoding unchanged.
 *
 * Defensive choices (all motivated by "this parses untrusted input on a
 * public endpoint"): depth-capped recursion on AnyValue/KeyValue to prevent
 * stack exhaustion, wire-type mismatches are treated as unknown-field skips
 * rather than silent data corruption, and `readOTLPBody` enforces a hard
 * cap on decompressed size to defuse gzip/deflate bombs.
 */

/** Max nesting depth for AnyValue/KeyValue/kvlist/array recursion. */
const MAX_VALUE_DEPTH = 32;

export class OTLPProtoDecodeError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'OTLPProtoDecodeError';
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * btoa needs a binary (latin-1) string. Building it via `s += fromCharCode(b)`
 * in a loop is O(n²) because each `+=` re-allocates. Chunking through
 * `String.fromCharCode` keeps it O(n) while staying under the
 * argument limit.
 */
const BASE64_CHUNK = 0x8000;
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}

/**
 * Verify the wire type on the field we're about to read; on mismatch, skip
 * the field (treating it as if it were unknown) instead of reading the next
 * bytes with the wrong reader and producing silent corruption.
 */
function expect(r: Reader, wire: number, expected: number): boolean {
  if (wire === expected) return true;
  r.skip(wire);
  return false;
}

function decodeAnyValue(r: Reader, depth: number): OTLPAnyValue {
  if (depth > MAX_VALUE_DEPTH) {
    throw new WireReadError('AnyValue nesting too deep');
  }
  const value: OTLPAnyValue = {};
  while (!r.eof()) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1:
        if (!expect(r, wire, WIRE_LEN)) break;
        value.stringValue = r.string();
        break;
      case 2:
        if (!expect(r, wire, WIRE_VARINT)) break;
        value.boolValue = r.bool();
        break;
      case 3:
        if (!expect(r, wire, WIRE_VARINT)) break;
        value.intValue = r.varintBigInt().toString();
        break;
      case 4:
        if (!expect(r, wire, WIRE_FIXED64)) break;
        value.doubleValue = r.double();
        break;
      case 5: {
        if (!expect(r, wire, WIRE_LEN)) break;
        const sub = r.subReader();
        const values: OTLPAnyValue[] = [];
        while (!sub.eof()) {
          const { field: f, wire: w } = sub.tag();
          if (f === 1 && w === WIRE_LEN) {
            values.push(decodeAnyValue(sub.subReader(), depth + 1));
          } else {
            sub.skip(w);
          }
        }
        value.arrayValue = { values };
        break;
      }
      case 6: {
        if (!expect(r, wire, WIRE_LEN)) break;
        const sub = r.subReader();
        const values: OTLPKeyValue[] = [];
        while (!sub.eof()) {
          const { field: f, wire: w } = sub.tag();
          if (f === 1 && w === WIRE_LEN) {
            values.push(decodeKeyValue(sub.subReader(), depth + 1));
          } else {
            sub.skip(w);
          }
        }
        value.kvlistValue = { values };
        break;
      }
      case 7: {
        if (!expect(r, wire, WIRE_LEN)) break;
        value.bytesValue = bytesToBase64(r.bytes());
        break;
      }
      default:
        r.skip(wire);
    }
  }
  return value;
}

function decodeKeyValue(r: Reader, depth: number): OTLPKeyValue {
  let key = '';
  let value: OTLPAnyValue = {};
  while (!r.eof()) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1:
        if (!expect(r, wire, WIRE_LEN)) break;
        key = r.string();
        break;
      case 2:
        if (!expect(r, wire, WIRE_LEN)) break;
        value = decodeAnyValue(r.subReader(), depth + 1);
        break;
      default:
        r.skip(wire);
    }
  }
  return { key, value };
}

function decodeResource(r: Reader): OTLPResource {
  const attributes: OTLPKeyValue[] = [];
  let droppedAttributesCount: number | undefined;
  while (!r.eof()) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1:
        if (!expect(r, wire, WIRE_LEN)) break;
        attributes.push(decodeKeyValue(r.subReader(), 1));
        break;
      case 2:
        if (!expect(r, wire, WIRE_VARINT)) break;
        droppedAttributesCount = r.varintNumber();
        break;
      default:
        r.skip(wire);
    }
  }
  const out: OTLPResource = { attributes };
  if (droppedAttributesCount !== undefined) out.droppedAttributesCount = droppedAttributesCount;
  return out;
}

interface DecodedScope {
  name?: string;
  version?: string;
  attributes?: OTLPKeyValue[];
  droppedAttributesCount?: number;
}

function decodeScope(r: Reader): DecodedScope {
  const scope: DecodedScope = {};
  const attributes: OTLPKeyValue[] = [];
  while (!r.eof()) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1:
        if (!expect(r, wire, WIRE_LEN)) break;
        scope.name = r.string();
        break;
      case 2:
        if (!expect(r, wire, WIRE_LEN)) break;
        scope.version = r.string();
        break;
      case 3:
        if (!expect(r, wire, WIRE_LEN)) break;
        attributes.push(decodeKeyValue(r.subReader(), 1));
        break;
      case 4:
        if (!expect(r, wire, WIRE_VARINT)) break;
        scope.droppedAttributesCount = r.varintNumber();
        break;
      default:
        r.skip(wire);
    }
  }
  if (attributes.length > 0) scope.attributes = attributes;
  return scope;
}

function decodeStatus(r: Reader): OTLPStatus {
  const status: OTLPStatus = {};
  while (!r.eof()) {
    const { field, wire } = r.tag();
    switch (field) {
      case 2:
        if (!expect(r, wire, WIRE_LEN)) break;
        status.message = r.string();
        break;
      case 3:
        if (!expect(r, wire, WIRE_VARINT)) break;
        status.code = r.varintNumber();
        break;
      default:
        r.skip(wire);
    }
  }
  return status;
}

function decodeEvent(r: Reader): OTLPSpanEvent {
  const event: OTLPSpanEvent = { name: '' };
  const attributes: OTLPKeyValue[] = [];
  while (!r.eof()) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1:
        if (!expect(r, wire, WIRE_FIXED64)) break;
        event.timeUnixNano = r.fixed64BigInt().toString();
        break;
      case 2:
        if (!expect(r, wire, WIRE_LEN)) break;
        event.name = r.string();
        break;
      case 3:
        if (!expect(r, wire, WIRE_LEN)) break;
        attributes.push(decodeKeyValue(r.subReader(), 1));
        break;
      case 4:
        if (!expect(r, wire, WIRE_VARINT)) break;
        event.droppedAttributesCount = r.varintNumber();
        break;
      default:
        r.skip(wire);
    }
  }
  if (attributes.length > 0) event.attributes = attributes;
  return event;
}

function decodeLink(r: Reader): OTLPSpanLink {
  const link: OTLPSpanLink = { traceId: '', spanId: '' };
  const attributes: OTLPKeyValue[] = [];
  while (!r.eof()) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1:
        if (!expect(r, wire, WIRE_LEN)) break;
        link.traceId = bytesToHex(r.bytes());
        break;
      case 2:
        if (!expect(r, wire, WIRE_LEN)) break;
        link.spanId = bytesToHex(r.bytes());
        break;
      case 3:
        if (!expect(r, wire, WIRE_LEN)) break;
        link.traceState = r.string();
        break;
      case 4:
        if (!expect(r, wire, WIRE_LEN)) break;
        attributes.push(decodeKeyValue(r.subReader(), 1));
        break;
      case 5:
        if (!expect(r, wire, WIRE_VARINT)) break;
        link.droppedAttributesCount = r.varintNumber();
        break;
      case 6:
        if (!expect(r, wire, WIRE_VARINT)) break;
        link.flags = r.varintNumber();
        break;
      default:
        r.skip(wire);
    }
  }
  if (attributes.length > 0) link.attributes = attributes;
  return link;
}

function decodeSpan(r: Reader): OTLPSpan {
  const span: OTLPSpan = {
    traceId: '',
    spanId: '',
    name: '',
    startTimeUnixNano: '0',
    endTimeUnixNano: '0',
  };
  const attributes: OTLPKeyValue[] = [];
  const events: OTLPSpanEvent[] = [];
  const links: OTLPSpanLink[] = [];
  while (!r.eof()) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1:
        if (!expect(r, wire, WIRE_LEN)) break;
        span.traceId = bytesToHex(r.bytes());
        break;
      case 2:
        if (!expect(r, wire, WIRE_LEN)) break;
        span.spanId = bytesToHex(r.bytes());
        break;
      case 3:
        if (!expect(r, wire, WIRE_LEN)) break;
        span.traceState = r.string();
        break;
      case 4:
        if (!expect(r, wire, WIRE_LEN)) break;
        span.parentSpanId = bytesToHex(r.bytes());
        break;
      case 5:
        if (!expect(r, wire, WIRE_LEN)) break;
        span.name = r.string();
        break;
      case 6:
        if (!expect(r, wire, WIRE_VARINT)) break;
        span.kind = r.varintNumber();
        break;
      case 7:
        if (!expect(r, wire, WIRE_FIXED64)) break;
        span.startTimeUnixNano = r.fixed64BigInt().toString();
        break;
      case 8:
        if (!expect(r, wire, WIRE_FIXED64)) break;
        span.endTimeUnixNano = r.fixed64BigInt().toString();
        break;
      case 9:
        if (!expect(r, wire, WIRE_LEN)) break;
        attributes.push(decodeKeyValue(r.subReader(), 1));
        break;
      case 10:
        if (!expect(r, wire, WIRE_VARINT)) break;
        span.droppedAttributesCount = r.varintNumber();
        break;
      case 11:
        if (!expect(r, wire, WIRE_LEN)) break;
        events.push(decodeEvent(r.subReader()));
        break;
      case 12:
        if (!expect(r, wire, WIRE_VARINT)) break;
        span.droppedEventsCount = r.varintNumber();
        break;
      case 13:
        if (!expect(r, wire, WIRE_LEN)) break;
        links.push(decodeLink(r.subReader()));
        break;
      case 14:
        if (!expect(r, wire, WIRE_VARINT)) break;
        span.droppedLinksCount = r.varintNumber();
        break;
      case 15:
        if (!expect(r, wire, WIRE_LEN)) break;
        span.status = decodeStatus(r.subReader());
        break;
      case 16:
        if (!expect(r, wire, WIRE_VARINT)) break;
        span.flags = r.varintNumber();
        break;
      default:
        r.skip(wire);
    }
  }
  if (attributes.length > 0) span.attributes = attributes;
  if (events.length > 0) span.events = events;
  if (links.length > 0) span.links = links;
  return span;
}

interface DecodedScopeSpans {
  scope?: DecodedScope;
  spans: OTLPSpan[];
  schemaUrl?: string;
}

function decodeScopeSpans(r: Reader): DecodedScopeSpans {
  const spans: OTLPSpan[] = [];
  const out: DecodedScopeSpans = { spans };
  while (!r.eof()) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1:
        if (!expect(r, wire, WIRE_LEN)) break;
        out.scope = decodeScope(r.subReader());
        break;
      case 2:
        if (!expect(r, wire, WIRE_LEN)) break;
        spans.push(decodeSpan(r.subReader()));
        break;
      case 3:
        if (!expect(r, wire, WIRE_LEN)) break;
        out.schemaUrl = r.string();
        break;
      default:
        r.skip(wire);
    }
  }
  return out;
}

function decodeResourceSpans(r: Reader): OTLPResourceSpans {
  const rs: OTLPResourceSpans = { scopeSpans: [] };
  while (!r.eof()) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1:
        if (!expect(r, wire, WIRE_LEN)) break;
        rs.resource = decodeResource(r.subReader());
        break;
      case 2:
        if (!expect(r, wire, WIRE_LEN)) break;
        rs.scopeSpans.push(decodeScopeSpans(r.subReader()));
        break;
      case 3:
        if (!expect(r, wire, WIRE_LEN)) break;
        rs.schemaUrl = r.string();
        break;
      default:
        r.skip(wire);
    }
  }
  return rs;
}

export function decodeOTLPProtobuf(buffer: Uint8Array): OTLPExportTraceServiceRequest {
  const resourceSpans: OTLPResourceSpans[] = [];
  try {
    const r = new Reader(buffer);
    while (!r.eof()) {
      const { field, wire } = r.tag();
      if (field === 1 && wire === WIRE_LEN) {
        resourceSpans.push(decodeResourceSpans(r.subReader()));
      } else {
        r.skip(wire);
      }
    }
  } catch (err) {
    if (err instanceof WireReadError) {
      throw new OTLPProtoDecodeError(`Malformed OTLP protobuf: ${err.message}`, err);
    }
    throw new OTLPProtoDecodeError('Failed to decode OTLP protobuf', err);
  }
  return { resourceSpans };
}

/**
 * Reads the request body and decompresses it if Content-Encoding indicates
 * gzip or deflate, enforcing a hard ceiling on the *decompressed* output.
 * Without this cap, a small compressed payload could inflate to hundreds of
 * MB (classic decompression bomb) and exhaust Worker memory/CPU.
 */
export async function readOTLPBody(
  body: ArrayBuffer,
  contentEncoding: string | undefined,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!contentEncoding || contentEncoding === 'identity') {
    if (body.byteLength > maxBytes) {
      throw new OTLPProtoDecodeError(`Payload exceeds ${maxBytes} bytes`);
    }
    return new Uint8Array(body);
  }

  const encoding = contentEncoding.toLowerCase();
  if (encoding !== 'gzip' && encoding !== 'deflate') {
    throw new OTLPProtoDecodeError(`Unsupported Content-Encoding: ${contentEncoding}`);
  }

  const ds = new DecompressionStream(encoding);
  const reader = new Blob([body]).stream().pipeThrough(ds).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new OTLPProtoDecodeError(`Decompressed payload exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
