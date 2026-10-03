import { describe, it, expect } from 'vitest';
import { decodeOTLPProtobuf, readOTLPBody, OTLPProtoDecodeError } from '../decode';
import { transformOTLPToTraces } from '../transform';
import { validateOTLPRequest } from '../validation';
import { validateImportedExecutionRequest } from '../imported/validate';
import { buildImportedExecutionTraces } from '../imported/traces';
import { IMPORTED_EXECUTION, GEN_AI_USAGE } from '@trace-flow/otel-conventions';
import { Writer, WIRE_FIXED64, WIRE_LEN, WIRE_VARINT } from '../wire';

import { encodeRequest, writeSpan } from './protobufFixtures';

function encodeRepeatedSpanFields(field: 9 | 11 | 13, count: number): Uint8Array {
  const top = new Writer();
  top.tag(1, WIRE_LEN).message((resource) => {
    resource.tag(2, WIRE_LEN).message((scope) => {
      scope.tag(2, WIRE_LEN).message((span) => {
        for (let index = 0; index < count; index += 1) {
          span.tag(field, WIRE_LEN).message(() => undefined);
        }
      });
    });
  });
  return top.toUint8Array();
}

function expectDecodeTooLarge(bytes: Uint8Array, message: RegExp): void {
  try {
    decodeOTLPProtobuf(bytes);
    throw new Error('expected protobuf decoder to reject the payload');
  } catch (error) {
    expect(error).toBeInstanceOf(OTLPProtoDecodeError);
    expect(error).toMatchObject({ status: 413 });
    expect((error as Error).message).toMatch(message);
  }
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

  it.each([
    ['trace ID', { traceIdHex: 'ab'.repeat(17) }],
    ['span ID', { spanIdHex: 'ab'.repeat(9) }],
    ['parent span ID', { parentSpanIdHex: 'ab'.repeat(9) }],
  ])('rejects an oversized protobuf %s before hex encoding', (_name, patch) => {
    const bytes = encodeRequest([
      {
        scopes: [
          {
            spans: [
              {
                traceIdHex,
                spanIdHex,
                name: 'oversized-identifier',
                startNano: 1n,
                endNano: 2n,
                ...patch,
              },
            ],
          },
        ],
      },
    ]);

    expectDecodeTooLarge(bytes, /length-delimited field exceeds/);
  });

  it.each([
    ['trace ID', { traceIdHex: 'ab'.repeat(17), spanIdHex }],
    ['span ID', { traceIdHex, spanIdHex: 'ab'.repeat(9) }],
  ])('rejects an oversized protobuf link %s before hex encoding', (_name, link) => {
    const bytes = encodeRequest([
      {
        scopes: [
          {
            spans: [
              {
                traceIdHex,
                spanIdHex,
                name: 'oversized-link-identifier',
                startNano: 1n,
                endNano: 2n,
                links: [link],
              },
            ],
          },
        ],
      },
    ]);

    expectDecodeTooLarge(bytes, /length-delimited field exceeds/);
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
  it('rejects compact repeated spans before materializing them', () => {
    const top = new Writer();
    top.tag(1, WIRE_LEN).message((resource) => {
      resource.tag(2, WIRE_LEN).message((scope) => {
        for (let index = 0; index < 5_001; index += 1) {
          scope.tag(2, WIRE_LEN).message(() => undefined);
        }
      });
    });

    const bytes = top.toUint8Array();
    expect(bytes.byteLength).toBeLessThan(11_000);
    expectDecodeTooLarge(bytes, /spans exceeds the 5000-item limit/);
  });

  it('rejects resource and scope collections during decoding', () => {
    expectDecodeTooLarge(
      encodeRequest(Array.from({ length: 1_025 }, () => ({ scopes: [] }))),
      /resourceSpans exceeds the 1024-item limit/,
    );
    expectDecodeTooLarge(
      encodeRequest([{ scopes: Array.from({ length: 4_097 }, () => ({ spans: [] })) }]),
      /scopeSpans exceeds the 4096-item limit/,
    );
  });

  it.each([
    ['attributes', 9],
    ['events', 11],
    ['links', 13],
  ] as const)('rejects excess span %s fields during decoding', (label, field) => {
    expectDecodeTooLarge(encodeRepeatedSpanFields(field, 257), new RegExp(`Span ${label}`));
  });

  it('rejects aggregate repeated fields before cumulative materialization', () => {
    const top = new Writer();
    top.tag(1, WIRE_LEN).message((resource) => {
      resource.tag(2, WIRE_LEN).message((scope) => {
        for (let spanIndex = 0; spanIndex < 196; spanIndex += 1) {
          scope.tag(2, WIRE_LEN).message((span) => {
            for (let attributeIndex = 0; attributeIndex < 256; attributeIndex += 1) {
              span.tag(9, WIRE_LEN).message(() => undefined);
            }
          });
        }
      });
    });

    const bytes = top.toUint8Array();
    expect(bytes.byteLength).toBeLessThan(110_000);
    expectDecodeTooLarge(bytes, /50000-item decode limit/);
  });

  it('rejects excess nested values during decoding', () => {
    const bytes = encodeRequest([
      {
        scopes: [
          {
            spans: [
              {
                traceIdHex: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
                spanIdHex: '1234567890abcdef',
                name: 'nested-values',
                startNano: 1n,
                endNano: 2n,
                attributes: [
                  {
                    key: 'nested',
                    value: {
                      arrayValue: Array.from({ length: 257 }, () => ({ stringValue: '' })),
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);

    expectDecodeTooLarge(bytes, /AnyValue\.arrayValue exceeds the 256-item limit/);
  });

  it('rejects oversized strings and byte values before decoding them', () => {
    expectDecodeTooLarge(
      encodeRequest([
        {
          scopes: [
            {
              spans: [
                {
                  traceIdHex: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
                  spanIdHex: '1234567890abcdef',
                  name: 'x'.repeat(64 * 1_024 + 1),
                  startNano: 1n,
                  endNano: 2n,
                },
              ],
            },
          ],
        },
      ]),
      /length-delimited field exceeds the 65536-byte limit/,
    );

    expectDecodeTooLarge(
      encodeRequest([
        {
          scopes: [
            {
              spans: [
                {
                  traceIdHex: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
                  spanIdHex: '1234567890abcdef',
                  name: 'bytes',
                  startNano: 1n,
                  endNano: 2n,
                  attributes: [
                    {
                      key: 'payload',
                      value: { bytesValue: new Uint8Array(192 * 1_024 + 1) },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ]),
      /length-delimited field exceeds the 196608-byte limit/,
    );
  });

  it('rejects deeply nested kvlistValue to prevent stack exhaustion', () => {
    // Wrap a 200-deep chain of KeyValueList → KeyValue → AnyValue(kvlist) …
    // around one span. The runtime cap is 8, so this should reject.
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
  it('decodes a protobuf CLIProxyAPI v2 execution through the imported contract', async () => {
    const executionId = 'aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaa1';
    const encoded = encodeRequest([
      {
        resourceAttributes: [
          {
            key: 'cliproxyapi.installation.id',
            value: { stringValue: '11111111-1111-4111-8111-111111111111' },
          },
          { key: 'service.name', value: { stringValue: 'CLIProxyAPI' } },
        ],
        scopes: [
          {
            name: IMPORTED_EXECUTION.SCOPE_NAME,
            version: IMPORTED_EXECUTION.SCOPE_VERSION,
            spans: [
              {
                traceIdHex: executionId,
                spanIdHex: executionId.slice(16),
                name: 'gpt-5',
                kind: 2,
                startNano: 1_000_000_000n,
                endNano: 2_000_000_000n,
                status: { code: 1 },
                attributes: [
                  {
                    key: 'cliproxyapi.execution.id',
                    value: { stringValue: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' },
                  },
                  { key: 'gen_ai.system', value: { stringValue: 'openai' } },
                  { key: 'gen_ai.request.model', value: { stringValue: 'gpt-5' } },
                  { key: 'cliproxyapi.account.coverage', value: { stringValue: 'unknown' } },
                  { key: GEN_AI_USAGE.MISSING, value: { boolValue: true } },
                ],
              },
            ],
          },
        ],
      },
    ]);
    const decoded = decodeOTLPProtobuf(encoded);
    expect(validateOTLPRequest(decoded).valid).toBe(true);
    const imported = validateImportedExecutionRequest(decoded);
    expect(imported.valid).toBe(true);
    if (!imported.valid) return;
    const traces = await buildImportedExecutionTraces(
      imported.executions,
      'key',
      'org-a',
      3_000_000_000,
    );
    expect(traces).toHaveLength(1);
    expect(traces[0]!.SpanAttributes[GEN_AI_USAGE.MISSING]).toBe('true');
    expect(traces[0]!.SpanAttributes[GEN_AI_USAGE.TOTAL_TOKENS]).toBeUndefined();
  });
});
