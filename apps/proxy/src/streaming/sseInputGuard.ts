export const MAX_SSE_INCOMPLETE_EVENT_CHARS = 4 * 1024 * 1024;
export const MAX_SSE_NON_DATA_LINE_CHARS = 1024;
export const MAX_SSE_LINES_PER_EVENT = 32;

const LINE_BLOCK_CHARS = 4 * 1024;
const DATA_FIELD_PREFIX = 'data:';
const MAX_BOUNDARY_PREFIX_CHARS = 3;
const BLANK_LINE_PATTERN = /\r?\n\r?\n/;

type LineKind = 'unknown' | 'data' | 'non-data';

interface SSEInputGuardOptions {
  onLine: (normalizedLine: string) => boolean;
  onViolation: () => void;
}

export interface SSEInputGuard {
  feed: (chunk: string) => void;
  reset: () => void;
}

/**
 * Bounds protocol framing before eventsource-parser sees it. Provider streams use one JSON
 * `data` field per event, so rejecting multi-data events avoids the parser's concatenation path.
 */
export function createSSEInputGuard(options: SSEInputGuardOptions): SSEInputGuard {
  const lineBlocks: string[] = [];
  const lineFragments: string[] = [];
  let lineFragmentChars = 0;
  let lineChars = 0;
  let linePrefix = '';
  let lineKind: LineKind = 'unknown';
  let eventChars = 0;
  let eventLines = 0;
  let hasDataLine = false;
  let skipLeadingLF = false;
  let recovering = false;
  let recoveryPrefix = '';

  function clearLine(): void {
    lineBlocks.length = 0;
    lineFragments.length = 0;
    lineFragmentChars = 0;
    lineChars = 0;
    linePrefix = '';
    lineKind = 'unknown';
  }

  function clearEvent(): void {
    clearLine();
    eventChars = 0;
    eventLines = 0;
    hasDataLine = false;
    skipLeadingLF = false;
  }

  function startRecovery(): void {
    clearEvent();
    recovering = true;
    recoveryPrefix = '';
    options.onViolation();
  }

  function updateLineKind(value: string): void {
    if (lineKind !== 'unknown') return;

    const remainingPrefixChars = DATA_FIELD_PREFIX.length - linePrefix.length;
    linePrefix += value.slice(0, remainingPrefixChars);
    if (!DATA_FIELD_PREFIX.startsWith(linePrefix)) {
      lineKind = 'non-data';
    } else if (linePrefix === DATA_FIELD_PREFIX) {
      lineKind = 'data';
    }
  }

  function appendLine(value: string): boolean {
    if (value.length === 0) return true;

    updateLineKind(value);
    if (lineKind === 'data' && hasDataLine) return false;

    const nextLineChars = lineChars + value.length;
    const nextEventChars = eventChars + value.length;
    if (nextEventChars > MAX_SSE_INCOMPLETE_EVENT_CHARS) return false;
    if (lineKind === 'non-data' && nextLineChars > MAX_SSE_NON_DATA_LINE_CHARS) return false;

    lineFragments.push(value);
    lineFragmentChars += value.length;
    lineChars = nextLineChars;
    eventChars = nextEventChars;

    if (lineFragmentChars >= LINE_BLOCK_CHARS) {
      lineBlocks.push(lineFragments.join(''));
      lineFragments.length = 0;
      lineFragmentChars = 0;
    }
    return true;
  }

  function normalizedLine(): string {
    lineFragments.push('\n');
    if (lineBlocks.length === 0) return lineFragments.join('');
    lineBlocks.push(lineFragments.join(''));
    return lineBlocks.join('');
  }

  function completeLine(): boolean {
    if (lineChars === 0) {
      if (!options.onLine('\n')) return false;
      clearEvent();
      return true;
    }

    if (lineKind === 'unknown') {
      lineKind = linePrefix === 'data' ? 'data' : 'non-data';
    }
    if (lineKind === 'data' && hasDataLine) return false;
    if (eventLines + 1 > MAX_SSE_LINES_PER_EVENT) return false;

    hasDataLine ||= lineKind === 'data';
    eventLines++;
    if (!options.onLine(normalizedLine())) return false;
    clearLine();
    return true;
  }

  function nextLineEnd(chunk: string, offset: number): number {
    const crIndex = chunk.indexOf('\r', offset);
    const lfIndex = chunk.indexOf('\n', offset);
    if (crIndex === -1) return lfIndex;
    if (lfIndex === -1) return crIndex;
    return Math.min(crIndex, lfIndex);
  }

  function processActive(chunk: string): number | undefined {
    let offset = 0;
    while (offset < chunk.length) {
      if (skipLeadingLF) {
        skipLeadingLF = false;
        if (chunk.charCodeAt(offset) === 10) {
          offset++;
          continue;
        }
      }

      const lineEnd = nextLineEnd(chunk, offset);
      if (lineEnd === -1) {
        return appendLine(chunk.slice(offset)) ? undefined : chunk.length;
      }
      if (!appendLine(chunk.slice(offset, lineEnd))) return lineEnd;
      if (!completeLine()) return lineEnd;

      skipLeadingLF = chunk.charCodeAt(lineEnd) === 13;
      offset = lineEnd + 1;
    }
    return undefined;
  }

  function recover(chunk: string): string | undefined {
    const prefixChars = recoveryPrefix.length;
    const candidate = recoveryPrefix + chunk;
    const boundary = BLANK_LINE_PATTERN.exec(candidate);
    if (!boundary) {
      recoveryPrefix = candidate.slice(-MAX_BOUNDARY_PREFIX_CHARS);
      return undefined;
    }

    recovering = false;
    recoveryPrefix = '';
    const consumedChunkChars = Math.max(0, boundary.index + boundary[0].length - prefixChars);
    return chunk.slice(consumedChunkChars);
  }

  return {
    feed(chunk) {
      let remaining = chunk;
      while (true) {
        if (recovering) {
          const resumed = recover(remaining);
          if (resumed === undefined) return;
          remaining = resumed;
        }
        if (remaining.length === 0) return;

        const violationOffset = processActive(remaining);
        if (violationOffset === undefined) return;
        startRecovery();
        remaining = remaining.slice(violationOffset);
      }
    },
    reset() {
      clearEvent();
      recovering = false;
      recoveryPrefix = '';
    },
  };
}
