import { luhnValid, redactSensitiveJsonValues, redactText } from './redaction';

const SSE_LINE_SPLIT_PATTERN = /(\r\n|\r|\n)/;
const SSE_FIELD_PATTERN = /^(?:data|event|id|retry):|^:/;
const JSON_STRUCTURE_TOKEN =
  /\s+|[{}[\]:,]|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
// 13-digit runs are left alone: in numeric position they are millisecond timestamps far more
// often than legacy 13-digit Visa numbers.
const CARD_NUMBER_TOKEN = /^\d{14,19}$/;
const REDACTED_JSON_VALUE = '"[REDACTED]"';

function isCardNumber(token: string): boolean {
  return CARD_NUMBER_TOKEN.test(token) && luhnValid(token);
}

/**
 * Redacts the text between JSON string literals. Valid JSON structure is kept
 * byte for byte, because its digit runs are numbers (timestamps, token counts)
 * that the text patterns would rewrite into invalid JSON. Card-shaped numbers
 * become a string placeholder so the document stays parseable. Anything that is
 * not a clean JSON token sequence (a truncated tail, malformed or non-JSON text)
 * gets full-text redaction instead.
 */
function redactStructure(segment: string): string {
  let out = '';
  let index = 0;
  let previousWasValue = false;
  while (index < segment.length) {
    JSON_STRUCTURE_TOKEN.lastIndex = index;
    const token = JSON_STRUCTURE_TOKEN.exec(segment)?.[0];
    if (!token) return redactText(segment);
    index += token.length;

    const first = token.charAt(0);
    if (first.trim() === '') {
      out += token;
    } else if ('{}[]:,'.includes(first)) {
      out += token;
      previousWasValue = false;
    } else {
      // Two values with only whitespace between them ("4111 1111 …", "123-45-6789")
      // is not JSON, so treat the segment as free text.
      if (previousWasValue) return redactText(segment);
      previousWasValue = true;
      out += isCardNumber(token) ? REDACTED_JSON_VALUE : token;
    }
  }
  return out;
}

function redactStringLiteral(literal: string): string {
  let decoded: unknown;
  try {
    decoded = JSON.parse(literal);
  } catch {
    return redactText(literal);
  }
  if (typeof decoded !== 'string') return redactText(literal);
  const redacted = redactText(decoded);
  // Re-encoding an untouched literal could rewrite escapes like `\/` or `é`.
  return redacted === decoded ? literal : JSON.stringify(redacted);
}

/**
 * Redacts a JSON document by scanning string literals instead of the raw text.
 * Anything between literals that is not plain JSON structure (a truncated tail,
 * an unterminated string, non-JSON text) falls back to full-text redaction.
 */
function redactJsonDocument(text: string): string {
  let out = '';
  let segmentStart = 0;
  let index = 0;

  while (index < text.length) {
    if (text[index] !== '"') {
      index++;
      continue;
    }
    let end = index + 1;
    while (end < text.length && text[end] !== '"') {
      end += text[end] === '\\' ? 2 : 1;
    }
    if (end >= text.length) break;

    out += redactStructure(text.slice(segmentStart, index));
    out += redactStringLiteral(text.slice(index, end + 1));
    index = end + 1;
    segmentStart = index;
  }

  out += redactStructure(text.slice(segmentStart));
  return redactSensitiveJsonValues(out);
}

function looksLikeJson(text: string): boolean {
  const first = text.trimStart()[0];
  return first === '{' || first === '[';
}

function redactSSELine(line: string): string {
  if (!line.startsWith('data:')) return redactText(line);
  const payloadStart = line.startsWith('data: ') ? 6 : 5;
  const payload = line.slice(payloadStart);
  const redacted = looksLikeJson(payload) ? redactJsonDocument(payload) : redactText(payload);
  return line.slice(0, payloadStart) + redacted;
}

function looksLikeSSE(text: string): boolean {
  const firstLine = text.trimStart().split(SSE_LINE_SPLIT_PATTERN, 1)[0] ?? '';
  return SSE_FIELD_PATTERN.test(firstLine);
}

/**
 * Redacts a persisted request or response body while keeping its format intact.
 * JSON and SSE-of-JSON bodies are redacted per string value so numeric fields
 * survive; any other body gets the plain-text pattern passes.
 */
export function redactBody(text: string): string {
  if (!text) return text;
  if (looksLikeJson(text)) return redactJsonDocument(text);
  if (looksLikeSSE(text)) {
    return text
      .split(SSE_LINE_SPLIT_PATTERN)
      .map((part, i) => (i % 2 === 1 ? part : redactSSELine(part)))
      .join('');
  }
  return redactText(text);
}
