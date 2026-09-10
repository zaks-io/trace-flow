import { describe, expect, it } from 'vitest';
import { emptyAccumulator } from '../facts';
import { agentFactRpcBatchBytes, chunkAgentFactRpcBatches } from '../fact-rpc-batches';

describe('chunkAgentFactRpcBatches', () => {
  it('includes the exact row-count boundary and starts a new deterministic chunk above it', () => {
    const rows = emptyAccumulator();
    rows.messages.push({ id: 'first' }, { id: 'second' }, { id: 'third' });

    const first = chunkAgentFactRpcBatches(rows, true, false, {
      maxRows: 2,
      maxBytes: 10_000,
    });
    const second = chunkAgentFactRpcBatches(rows, true, false, {
      maxRows: 2,
      maxBytes: 10_000,
    });

    expect(first).toEqual(second);
    expect(first.map((batch) => batch.rows.messages)).toEqual([
      [{ id: 'first' }, { id: 'second' }],
      [{ id: 'third' }],
    ]);
  });

  it('includes an RPC whose serialized size exactly equals the byte limit', () => {
    const rows = emptyAccumulator();
    rows.messages.push({ id: 'boundary', content: 'é'.repeat(100) });
    const expected = { rows, writeClean: true, writeLegacy: false };
    const exactBytes = agentFactRpcBatchBytes(expected);

    const chunks = chunkAgentFactRpcBatches(rows, true, false, {
      maxRows: 10,
      maxBytes: exactBytes,
    });

    expect(chunks).toEqual([expected]);
    expect(agentFactRpcBatchBytes(chunks[0]!)).toBe(exactBytes);
  });

  it('splits before either serialized bytes or row count exceeds its cap', () => {
    const rows = emptyAccumulator();
    rows.messages.push({ id: 'a', content: 'x'.repeat(40) });
    rows.tool_events.push({ id: 'b', content: 'y'.repeat(40) });
    rows.file_events.push({ id: 'c', content: 'z'.repeat(40) });
    const oneRow = emptyAccumulator();
    oneRow.messages.push(rows.messages[0]);
    const oneRowBytes = agentFactRpcBatchBytes({
      rows: oneRow,
      writeClean: true,
      writeLegacy: false,
    });

    const chunks = chunkAgentFactRpcBatches(rows, true, false, {
      maxRows: 2,
      maxBytes: oneRowBytes,
    });

    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) {
      expect(agentFactRpcBatchBytes(chunk)).toBeLessThanOrEqual(oneRowBytes);
    }
    expect(
      chunks.map((chunk) =>
        Object.values(chunk.rows)
          .flat()
          .map((row) => (row as { id: string }).id),
      ),
    ).toEqual([['a'], ['b'], ['c']]);
  });

  it('fails loudly when one row cannot fit in an otherwise empty RPC', () => {
    const rows = emptyAccumulator();
    rows.messages.push({ content: 'x'.repeat(100) });
    const maxBytes =
      agentFactRpcBatchBytes({
        rows: emptyAccumulator(),
        writeClean: true,
        writeLegacy: false,
      }) + 10;

    expect(() => chunkAgentFactRpcBatches(rows, true, false, { maxRows: 10, maxBytes })).toThrow(
      `RPC messages row exceeds the ${maxBytes}-byte batch limit`,
    );
  });
});
