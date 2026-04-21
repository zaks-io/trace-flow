import { describe, it, expect } from 'vitest';
import { decodeOTLPProtobuf, readOTLPBody, OTLPProtoDecodeError } from '../decode';
import { transformOTLPToTraces } from '../transform';
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

function writeSpan(w: Writer, span: SpanInput): void {
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

function encodeRequest(resourceSpans: ResourceSpansInput[]): Uint8Array {
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

describe('decodeOTLPProtobuf', () => {
  const traceIdHex = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
  const spanIdHex = '1234567890abcdef';
  const parentSpanIdHex = 'fedcba0987654321';

  it('decodes a minimal protobuf payload into the JSON-shaped request', () => {
    const buf = encodeRequest([
      {
        resourceAttributes: [{ key: 'service.name', value: { stringValue: 'claude-agents' } }],
        scopes: [
          {
            name: 'claude_telemetry',
            version: '1.0.0',
            spans: [
              {
                traceIdHex,
                spanIdHex,
                parentSpanIdHex,
                name: 'claude.agent.run',
                kind: 1,
                startNano: 1700000000000000000n,
                endNano: 1700000001000000000n,
                attributes: [
                  { key: 'gen_ai.request.model', value: { stringValue: 'sonnet' } },
                  { key: 'gen_ai.usage.input_tokens', value: { intValue: 123 } },
                  { key: 'retry', value: { boolValue: false } },
                ],
                status: { code: 1, message: 'ok' },
              },
            ],
          },
        ],
      },
    ]);

    const decoded = decodeOTLPProtobuf(buf);
    expect(decoded.resourceSpans).toHaveLength(1);

    const rs = decoded.resourceSpans[0]!;
    expect(rs.resource?.attributes?.[0]).toEqual({
      key: 'service.name',
      value: { stringValue: 'claude-agents' },
    });

    const ss = rs.scopeSpans[0]!;
    expect(ss.scope?.name).toBe('claude_telemetry');

    const span = ss.spans[0]!;
    expect(span.traceId).toBe(traceIdHex);
    expect(span.spanId).toBe(spanIdHex);
    expect(span.parentSpanId).toBe(parentSpanIdHex);
    expect(span.name).toBe('claude.agent.run');
    expect(span.kind).toBe(1);
    expect(span.startTimeUnixNano).toBe('1700000000000000000');
    expect(span.endTimeUnixNano).toBe('1700000001000000000');
    expect(span.status).toEqual({ code: 1, message: 'ok' });

    const attrs = span.attributes ?? [];
    expect(attrs).toContainEqual({
      key: 'gen_ai.request.model',
      value: { stringValue: 'sonnet' },
    });
    expect(attrs).toContainEqual({
      key: 'gen_ai.usage.input_tokens',
      value: { intValue: '123' },
    });
    expect(attrs).toContainEqual({
      key: 'retry',
      value: { boolValue: false },
    });
  });

  it('decodes events and links with hex-normalized IDs', () => {
    const linkedTraceHex = 'deadbeefcafebabedeadbeefcafebabe';
    const linkedSpanHex = '0badf00dd15ea5e0';

    const buf = encodeRequest([
      {
        scopes: [
          {
            spans: [
              {
                traceIdHex,
                spanIdHex,
                name: 'with-events',
                startNano: 1000n,
                endNano: 2000n,
                events: [
                  {
                    timeNano: 1500n,
                    name: 'tool.read',
                    attributes: [{ key: 'tool.name', value: { stringValue: 'Read' } }],
                  },
                ],
                links: [
                  {
                    traceIdHex: linkedTraceHex,
                    spanIdHex: linkedSpanHex,
                    traceState: 'vendor=value',
                    attributes: [{ key: 'link.type', value: { stringValue: 'follows_from' } }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);

    const decoded = decodeOTLPProtobuf(buf);
    const span = decoded.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;

    expect(span.events).toHaveLength(1);
    expect(span.events?.[0]).toMatchObject({
      name: 'tool.read',
      timeUnixNano: '1500',
    });

    expect(span.links).toHaveLength(1);
    expect(span.links?.[0]).toMatchObject({
      traceId: linkedTraceHex,
      spanId: linkedSpanHex,
      traceState: 'vendor=value',
    });
  });

  it('produces a request that the existing transform pipeline can consume', () => {
    const buf = encodeRequest([
      {
        resourceAttributes: [{ key: 'service.name', value: { stringValue: 'claude-agents' } }],
        scopes: [
          {
            spans: [
              {
                traceIdHex,
                spanIdHex,
                name: 'span-one',
                kind: 3,
                startNano: 1_000_000n,
                endNano: 2_000_000n,
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ]);

    const decoded = decodeOTLPProtobuf(buf);
    const traces = transformOTLPToTraces(decoded, 'test-key', 1_700_000_000_000_000_000);

    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      TraceId: traceIdHex,
      SpanId: spanIdHex,
      SpanName: 'span-one',
      SpanKind: 'SPAN_KIND_CLIENT',
      ServiceName: 'claude-agents',
      StatusCode: 'STATUS_CODE_OK',
      ApiKey: 'test-key',
      Duration: 1_000_000,
    });
  });

  it('handles an empty request', () => {
    const buf = encodeRequest([]);
    const decoded = decodeOTLPProtobuf(buf);
    expect(decoded.resourceSpans).toEqual([]);
  });

  it('throws OTLPProtoDecodeError on malformed bytes', () => {
    const garbage = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]);
    expect(() => decodeOTLPProtobuf(garbage)).toThrow(OTLPProtoDecodeError);
  });

  it('preserves unknown fields by skipping them', () => {
    // A real OTEL SDK may emit newer fields we do not model yet. Unknown
    // field numbers on recognised wire types should be skipped silently.
    const top = new Writer();
    top.tag(999, WIRE_VARINT).varintNumber(42);
    top.tag(1, WIRE_LEN).message((rsMsg) => {
      rsMsg.tag(2, WIRE_LEN).message((ss) => {
        ss.tag(2, WIRE_LEN).message((spanMsg) =>
          writeSpan(spanMsg, {
            traceIdHex,
            spanIdHex,
            name: 'unknown-field-tolerant',
            startNano: 1n,
            endNano: 2n,
          }),
        );
      });
    });
    const decoded = decodeOTLPProtobuf(top.toUint8Array());
    expect(decoded.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.name).toBe('unknown-field-tolerant');
  });

  it('base64-encodes bytesValue for blobs larger than the fromCharCode chunk size', () => {
    // 100KB patterned blob exercises the chunked path (BASE64_CHUNK = 32KB).
    const size = 100 * 1024;
    const blob = new Uint8Array(size);
    for (let i = 0; i < size; i++) blob[i] = i & 0xff;

    const buf = encodeRequest([
      {
        scopes: [
          {
            spans: [
              {
                traceIdHex,
                spanIdHex,
                name: 'large-bytes',
                startNano: 1n,
                endNano: 2n,
                attributes: [{ key: 'payload', value: { bytesValue: blob } }],
              },
            ],
          },
        ],
      },
    ]);

    const decoded = decodeOTLPProtobuf(buf);
    const attr = decoded.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes![0]!;
    const encoded = attr.value.bytesValue!;

    // Round-trip base64 → bytes and confirm byte-for-byte equality.
    const bin = atob(encoded);
    expect(bin.length).toBe(size);
    for (let i = 0; i < size; i++) {
      expect(bin.charCodeAt(i)).toBe(blob[i]);
    }
  });

  it('skips unknown varint fields carrying values larger than MAX_SAFE_INTEGER', () => {
    // A future OTLP field might be a uint64 with any value up to 2^64-1.
    // Skipping should scan bytes, not decode the value — so a 10-byte varint
    // representing the uint64 max must not trip the "varint exceeds safe
    // integer" guard that only applies to fields we actually read.
    const top = new Writer();
    // Unknown field 500 with a ten-byte varint (all continuation bits set
    // except the last), encoding uint64 max.
    top.tag(500, WIRE_VARINT).varintBigInt((1n << 64n) - 1n);
    top.tag(1, WIRE_LEN).message((rsMsg) => {
      rsMsg.tag(2, WIRE_LEN).message((ss) => {
        ss.tag(2, WIRE_LEN).message((spanMsg) =>
          writeSpan(spanMsg, {
            traceIdHex,
            spanIdHex,
            name: 'tolerant-of-large-unknown-varint',
            startNano: 1n,
            endNano: 2n,
          }),
        );
      });
    });
    const decoded = decodeOTLPProtobuf(top.toUint8Array());
    expect(decoded.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.name).toBe(
      'tolerant-of-large-unknown-varint',
    );
  });
});

describe('readOTLPBody', () => {
  const CAP = 10 * 1024 * 1024;

  it('passes through identity encoding', async () => {
    const input = new Uint8Array([1, 2, 3, 4]);
    const out = await readOTLPBody(input.buffer, undefined, CAP);
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
  });

  it('decompresses gzip bodies', async () => {
    const original = new TextEncoder().encode('hello otlp');
    const cs = new CompressionStream('gzip');
    const compressed = await new Response(
      new Blob([original]).stream().pipeThrough(cs),
    ).arrayBuffer();

    const out = await readOTLPBody(compressed, 'gzip', CAP);
    expect(new TextDecoder().decode(out)).toBe('hello otlp');
  });

  it('rejects unsupported encodings', async () => {
    await expect(readOTLPBody(new ArrayBuffer(0), 'brotli', CAP)).rejects.toThrow(
      OTLPProtoDecodeError,
    );
  });

  it('rejects identity bodies over the cap', async () => {
    const oversized = new Uint8Array(100);
    await expect(readOTLPBody(oversized.buffer, undefined, 50)).rejects.toThrow(
      OTLPProtoDecodeError,
    );
  });

  it('rejects decompressed output over the cap (gzip bomb defense)', async () => {
    // 1MB of zeros compresses to a few KB; caps it at 100 bytes decompressed.
    const payload = new Uint8Array(1024 * 1024);
    const cs = new CompressionStream('gzip');
    const compressed = await new Response(
      new Blob([payload]).stream().pipeThrough(cs),
    ).arrayBuffer();

    await expect(readOTLPBody(compressed, 'gzip', 100)).rejects.toThrow(OTLPProtoDecodeError);
  });
});

describe('decoder hardening', () => {
  it('rejects deeply nested kvlistValue to prevent stack exhaustion', () => {
    // Wrap a 200-deep chain of KeyValueList → KeyValue → AnyValue(kvlist) …
    // around one span. Cap is 32, so this should reject.
    const DEPTH = 200;
    const inner = new Writer();
    // innermost AnyValue is a plain string
    inner.tag(1, WIRE_LEN).string('leaf');

    let current = inner.toUint8Array();
    for (let i = 0; i < DEPTH; i++) {
      const next = new Writer();
      // AnyValue.kvlistValue = { values: [ KeyValue{ key: "k", value: <current> } ] }
      next.tag(6, WIRE_LEN).message((kvlist) => {
        kvlist.tag(1, WIRE_LEN).message((kv) => {
          kv.tag(1, WIRE_LEN).string('k');
          kv.tag(2, WIRE_LEN).bytes(current);
        });
      });
      current = next.toUint8Array();
    }

    // Wrap in a minimal valid request that exercises the depth-capped path.
    const top = new Writer();
    top.tag(1, WIRE_LEN).message((rs) => {
      rs.tag(2, WIRE_LEN).message((ss) => {
        ss.tag(2, WIRE_LEN).message((span) => {
          span.tag(1, WIRE_LEN).bytes(new Uint8Array(16));
          span.tag(2, WIRE_LEN).bytes(new Uint8Array(8));
          span.tag(5, WIRE_LEN).string('deep');
          span.tag(7, WIRE_FIXED64).fixed64BigInt(1n);
          span.tag(8, WIRE_FIXED64).fixed64BigInt(2n);
          // attribute: KeyValue{ key: "a", value: <deeply-nested AnyValue> }
          span.tag(9, WIRE_LEN).message((kv) => {
            kv.tag(1, WIRE_LEN).string('a');
            kv.tag(2, WIRE_LEN).bytes(current);
          });
        });
      });
    });

    expect(() => decodeOTLPProtobuf(top.toUint8Array())).toThrow(/nesting too deep/);
  });

  it('treats wire-type mismatches as unknown fields instead of silent corruption', () => {
    // Send a Span.traceId (field 1, normally WIRE_LEN) as a varint instead.
    // Decoder should skip it, leaving traceId empty — which the validator rejects.
    const top = new Writer();
    top.tag(1, WIRE_LEN).message((rs) => {
      rs.tag(2, WIRE_LEN).message((ss) => {
        ss.tag(2, WIRE_LEN).message((span) => {
          span.tag(1, WIRE_VARINT).varintNumber(12345); // wrong wire type for traceId
          span.tag(2, WIRE_LEN).bytes(new Uint8Array(8));
          span.tag(5, WIRE_LEN).string('mismatched');
          span.tag(7, WIRE_FIXED64).fixed64BigInt(1n);
          span.tag(8, WIRE_FIXED64).fixed64BigInt(2n);
        });
      });
    });

    const decoded = decodeOTLPProtobuf(top.toUint8Array());
    const span = decoded.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(span.traceId).toBe(''); // skipped, not corrupted
    expect(span.name).toBe('mismatched'); // other fields still decoded
  });
});
