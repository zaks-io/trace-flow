import { Writer, WIRE_FIXED64, WIRE_LEN, WIRE_VARINT } from '../wire';

/**
 * Small protobuf emitter that matches the field numbers and wire types of
 * opentelemetry.proto.trace.v1. Using this in tests makes the decoder's
 * expectations explicit — every byte the decoder consumes is one a real OTEL
 * SDK could produce.
 */

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

type AnyValueInput =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: bigint | number }
  | { doubleValue: number }
  | { arrayValue: AnyValueInput[] }
  | { kvlistValue: { key: string; value: AnyValueInput }[] }
  | { bytesValue: Uint8Array };

function writeAnyValue(w: Writer, v: AnyValueInput): void {
  if ('stringValue' in v) w.tag(1, WIRE_LEN).string(v.stringValue);
  else if ('boolValue' in v) w.tag(2, WIRE_VARINT).bool(v.boolValue);
  else if ('intValue' in v) w.tag(3, WIRE_VARINT).varintBigInt(BigInt(v.intValue));
  else if ('doubleValue' in v) w.tag(4, WIRE_FIXED64).double(v.doubleValue);
  else if ('arrayValue' in v) {
    w.tag(5, WIRE_LEN).message((sub) => {
      for (const inner of v.arrayValue)
        sub.tag(1, WIRE_LEN).message((m) => writeAnyValue(m, inner));
    });
  } else if ('kvlistValue' in v) {
    w.tag(6, WIRE_LEN).message((sub) => {
      for (const kv of v.kvlistValue)
        sub.tag(1, WIRE_LEN).message((m) => writeKeyValue(m, kv.key, kv.value));
    });
  } else if ('bytesValue' in v) {
    w.tag(7, WIRE_LEN).bytes(v.bytesValue);
  }
}

function writeKeyValue(w: Writer, key: string, value: AnyValueInput): void {
  w.tag(1, WIRE_LEN).string(key);
  w.tag(2, WIRE_LEN).message((m) => writeAnyValue(m, value));
}

interface SpanInput {
  traceIdHex: string;
  spanIdHex: string;
  parentSpanIdHex?: string;
  traceState?: string;
  name: string;
  kind?: number;
  startNano: bigint;
  endNano: bigint;
  attributes?: { key: string; value: AnyValueInput }[];
  events?: {
    timeNano: bigint;
    name: string;
    attributes?: { key: string; value: AnyValueInput }[];
  }[];
  links?: {
    traceIdHex: string;
    spanIdHex: string;
    traceState?: string;
    attributes?: { key: string; value: AnyValueInput }[];
  }[];
  status?: { code: number; message?: string };
  flags?: number;
}

export function writeSpan(w: Writer, span: SpanInput): void {
  w.tag(1, WIRE_LEN).bytes(hexToBytes(span.traceIdHex));
  w.tag(2, WIRE_LEN).bytes(hexToBytes(span.spanIdHex));
  if (span.traceState) w.tag(3, WIRE_LEN).string(span.traceState);
  if (span.parentSpanIdHex) w.tag(4, WIRE_LEN).bytes(hexToBytes(span.parentSpanIdHex));
  w.tag(5, WIRE_LEN).string(span.name);
  if (span.kind !== undefined) w.tag(6, WIRE_VARINT).varintNumber(span.kind);
  w.tag(7, WIRE_FIXED64).fixed64BigInt(span.startNano);
  w.tag(8, WIRE_FIXED64).fixed64BigInt(span.endNano);
  if (span.attributes) {
    for (const a of span.attributes) {
      w.tag(9, WIRE_LEN).message((m) => writeKeyValue(m, a.key, a.value));
    }
  }
  if (span.events) {
    for (const ev of span.events) {
      w.tag(11, WIRE_LEN).message((m) => {
        m.tag(1, WIRE_FIXED64).fixed64BigInt(ev.timeNano);
        m.tag(2, WIRE_LEN).string(ev.name);
        if (ev.attributes) {
          for (const a of ev.attributes) {
            m.tag(3, WIRE_LEN).message((inner) => writeKeyValue(inner, a.key, a.value));
          }
        }
      });
    }
  }
  if (span.links) {
    for (const link of span.links) {
      w.tag(13, WIRE_LEN).message((m) => {
        m.tag(1, WIRE_LEN).bytes(hexToBytes(link.traceIdHex));
        m.tag(2, WIRE_LEN).bytes(hexToBytes(link.spanIdHex));
        if (link.traceState) m.tag(3, WIRE_LEN).string(link.traceState);
        if (link.attributes) {
          for (const a of link.attributes) {
            m.tag(4, WIRE_LEN).message((inner) => writeKeyValue(inner, a.key, a.value));
          }
        }
      });
    }
  }
  if (span.status) {
    w.tag(15, WIRE_LEN).message((m) => {
      if (span.status!.message) m.tag(2, WIRE_LEN).string(span.status!.message);
      m.tag(3, WIRE_VARINT).varintNumber(span.status!.code);
    });
  }
  if (span.flags !== undefined) w.tag(16, WIRE_VARINT).varintNumber(span.flags);
}

interface ResourceSpansInput {
  resourceAttributes?: { key: string; value: AnyValueInput }[];
  scopes: {
    name?: string;
    version?: string;
    spans: SpanInput[];
  }[];
}

export function encodeRequest(resourceSpans: ResourceSpansInput[]): Uint8Array {
  const top = new Writer();
  for (const rs of resourceSpans) {
    top.tag(1, WIRE_LEN).message((rsMsg) => {
      if (rs.resourceAttributes) {
        rsMsg.tag(1, WIRE_LEN).message((resMsg) => {
          for (const a of rs.resourceAttributes!) {
            resMsg.tag(1, WIRE_LEN).message((kv) => writeKeyValue(kv, a.key, a.value));
          }
        });
      }
      for (const scope of rs.scopes) {
        rsMsg.tag(2, WIRE_LEN).message((ss) => {
          if (scope.name || scope.version) {
            ss.tag(1, WIRE_LEN).message((scopeMsg) => {
              if (scope.name) scopeMsg.tag(1, WIRE_LEN).string(scope.name);
              if (scope.version) scopeMsg.tag(2, WIRE_LEN).string(scope.version);
            });
          }
          for (const span of scope.spans) {
            ss.tag(2, WIRE_LEN).message((spanMsg) => writeSpan(spanMsg, span));
          }
        });
      }
    });
  }
  return top.toUint8Array();
}
