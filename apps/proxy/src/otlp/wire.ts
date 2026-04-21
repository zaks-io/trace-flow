/**
 * Minimal protobuf wire-format reader/writer.
 *
 * Cloudflare Workers disallow runtime code generation from strings, which
 * rules out protobufjs and similar reflective decoders that compile hot paths
 * at load time. This module implements only the slice of the protobuf wire
 * format that OTLP trace messages use: varints, 64-bit fixed, and
 * length-delimited fields.
 *
 * All readers are defensive against malicious input: bounds checks on every
 * advance, explicit rejection of negative/overflowing lengths, and a cap on
 * 64-bit varints so a hostile client cannot push unbounded BigInts through.
 *
 * @see https://protobuf.dev/programming-guides/encoding/
 */

export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_LEN = 2;
export const WIRE_FIXED32 = 5;

const U64_MAX = (1n << 64n) - 1n;
const textDecoder = new TextDecoder();

export class WireReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WireReadError';
  }
}

export class Reader {
  private pos = 0;

  constructor(private readonly buf: Uint8Array) {}

  get offset(): number {
    return this.pos;
  }

  eof(): boolean {
    return this.pos >= this.buf.length;
  }

  remaining(): number {
    return this.buf.length - this.pos;
  }

  tag(): { field: number; wire: number } {
    const t = this.varintNumber();
    return { field: t >>> 3, wire: t & 0x07 };
  }

  /**
   * Read an unsigned varint as a non-negative JS number.
   *
   * Switches from bitwise shift to float math at shift=21. A 7-bit chunk
   * shifted left 21 produces values with bit 27 set, and the next iteration
   * (shift=28) would set bit 34 via bitwise OR, which JS interprets on a
   * signed int32 and silently corrupts the value into a negative — which
   * would then underflow downstream length calculations. Using math above
   * shift=21 keeps the accumulator non-negative throughout.
   */
  varintNumber(): number {
    let result = 0;
    let shift = 0;
    while (this.pos < this.buf.length) {
      const b = this.buf[this.pos++]!;
      if (shift < 21) {
        result |= (b & 0x7f) << shift;
      } else {
        result += (b & 0x7f) * Math.pow(2, shift);
      }
      if ((b & 0x80) === 0) {
        if (result > Number.MAX_SAFE_INTEGER) {
          throw new WireReadError('varint exceeds safe integer');
        }
        return result;
      }
      shift += 7;
      if (shift > 63) throw new WireReadError('varint too long');
    }
    throw new WireReadError('unexpected EOF reading varint');
  }

  /** Read an unsigned varint as a BigInt, masked to 64 bits. */
  varintBigInt(): bigint {
    let result = 0n;
    let shift = 0n;
    while (this.pos < this.buf.length) {
      const b = this.buf[this.pos++]!;
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result & U64_MAX;
      shift += 7n;
      if (shift > 63n) throw new WireReadError('varint too long');
    }
    throw new WireReadError('unexpected EOF reading varint');
  }

  bool(): boolean {
    return this.varintNumber() !== 0;
  }

  fixed64BigInt(): bigint {
    if (this.pos + 8 > this.buf.length) {
      throw new WireReadError('unexpected EOF reading fixed64');
    }
    let result = 0n;
    for (let i = 0; i < 8; i++) {
      result |= BigInt(this.buf[this.pos + i]!) << BigInt(i * 8);
    }
    this.pos += 8;
    return result;
  }

  double(): number {
    if (this.pos + 8 > this.buf.length) {
      throw new WireReadError('unexpected EOF reading double');
    }
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8);
    const v = view.getFloat64(0, true);
    this.pos += 8;
    return v;
  }

  fixed32(): number {
    if (this.pos + 4 > this.buf.length) {
      throw new WireReadError('unexpected EOF reading fixed32');
    }
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4);
    const v = view.getUint32(0, true);
    this.pos += 4;
    return v;
  }

  bytes(): Uint8Array {
    const len = this.varintNumber();
    if (len < 0) throw new WireReadError('negative length');
    if (this.pos + len > this.buf.length) {
      throw new WireReadError('unexpected EOF reading bytes');
    }
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  string(): string {
    return textDecoder.decode(this.bytes());
  }

  /** Returns a Reader scoped to the next length-delimited sub-message. */
  subReader(): Reader {
    return new Reader(this.bytes());
  }

  /** Skip a field whose wire type we recognise but do not care about. */
  skip(wire: number): void {
    switch (wire) {
      case WIRE_VARINT:
        this.varintNumber();
        return;
      case WIRE_FIXED64:
        if (this.pos + 8 > this.buf.length) {
          throw new WireReadError('unexpected EOF skipping fixed64');
        }
        this.pos += 8;
        return;
      case WIRE_LEN: {
        const len = this.varintNumber();
        if (len < 0) throw new WireReadError('negative length in skip');
        if (this.pos + len > this.buf.length) {
          throw new WireReadError('unexpected EOF skipping length-delimited');
        }
        this.pos += len;
        return;
      }
      case WIRE_FIXED32:
        if (this.pos + 4 > this.buf.length) {
          throw new WireReadError('unexpected EOF skipping fixed32');
        }
        this.pos += 4;
        return;
      default:
        throw new WireReadError(`cannot skip unknown wire type ${wire}`);
    }
  }
}

export class Writer {
  private chunks: Uint8Array[] = [];

  toUint8Array(): Uint8Array {
    let total = 0;
    for (const c of this.chunks) total += c.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }

  tag(field: number, wire: number): Writer {
    this.varintNumber((field << 3) | wire);
    return this;
  }

  varintNumber(value: number): Writer {
    if (value < 0) throw new Error('negative varint not supported');
    const out: number[] = [];
    let v = value;
    while (v > 0x7f) {
      out.push((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(v & 0x7f);
    this.chunks.push(Uint8Array.from(out));
    return this;
  }

  varintBigInt(value: bigint): Writer {
    if (value < 0n) throw new Error('negative varint not supported');
    const out: number[] = [];
    let v = value;
    while (v > 0x7fn) {
      out.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    out.push(Number(v & 0x7fn));
    this.chunks.push(Uint8Array.from(out));
    return this;
  }

  fixed64BigInt(value: bigint): Writer {
    const buf = new Uint8Array(8);
    let v = value;
    for (let i = 0; i < 8; i++) {
      buf[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    this.chunks.push(buf);
    return this;
  }

  double(value: number): Writer {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, value, true);
    this.chunks.push(new Uint8Array(buf));
    return this;
  }

  bytes(value: Uint8Array): Writer {
    this.varintNumber(value.length);
    this.chunks.push(value);
    return this;
  }

  string(value: string): Writer {
    return this.bytes(new TextEncoder().encode(value));
  }

  bool(value: boolean): Writer {
    return this.varintNumber(value ? 1 : 0);
  }

  /** Write a nested message with a length prefix. */
  message(build: (w: Writer) => void): Writer {
    const inner = new Writer();
    build(inner);
    return this.bytes(inner.toUint8Array());
  }
}
