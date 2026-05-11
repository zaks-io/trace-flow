/**
 * Regex-based PII redaction for persisted LLM response copies.
 * Does not attempt semantic JSON parsing of full bodies — runs pattern passes on strings.
 */

const REDACTED = '[REDACTED]';

/** Luhn check on a string of digits only. */
export function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function normalizeCardDigits(match: string): string {
  return match.replace(/\D/g, '');
}

// 13–19 digits with optional separators between groups (spaces, dashes)
const CARD_CANDIDATE_PATTERN =
  /\b(?:\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{0,7}|\d{13,19})\b/g;

function redactCreditCards(text: string): string {
  return text.replace(CARD_CANDIDATE_PATTERN, (slice) => {
    const digits = normalizeCardDigits(slice);
    if (digits.length < 13 || digits.length > 19) return slice;
    return luhnValid(digits) ? REDACTED : slice;
  });
}

const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;

const IPV4_PATTERN = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g;

// US-style numbers; (?<![A-Za-z0-9]) so "(415) 555-0100" matches after a space (\\b fails before "(")
const PHONE_PATTERN =
  /(?<![A-Za-z0-9])(?:\+1\s?)?(?:\(\d{3}\)\s*|\d{3}[-.\s]?)\d{3}[-.\s]?\d{4}\b/g;

// Authorization: Bearer … — trailing \b breaks on base64 padding (= is non-word); use lookahead instead
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*(?=\s|$|[^A-Za-z0-9\-._~+/=])/gi;

// JSON-ish quoted values after sensitive keys (non-greedy string value)
const SENSITIVE_JSON_VALUE_PATTERN =
  /("(?:api_key|apikey|access_token|refresh_token|client_secret|password|secret|token|authorization|auth_token|private_key|x_api_key|x-api-key)"\s*:\s*")((?:[^"\\]|\\.)*)(")/gi;

/**
 * Applies common PII redaction patterns to a single string.
 */
export function redactText(text: string): string {
  if (!text) return text;

  let out = text;
  // Order: cards first (Luhn) to reduce false positives on long digit runs where applicable
  out = redactCreditCards(out);
  out = out.replace(EMAIL_PATTERN, REDACTED);
  out = out.replace(SSN_PATTERN, REDACTED);
  out = out.replace(IPV4_PATTERN, REDACTED);
  out = out.replace(PHONE_PATTERN, REDACTED);
  out = out.replace(BEARER_PATTERN, `Bearer ${REDACTED}`);
  out = out.replace(
    SENSITIVE_JSON_VALUE_PATTERN,
    (_m, prefix: string, _val: string, suffix: string) => {
      return `${prefix}${REDACTED}${suffix}`;
    },
  );

  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Deep-clones plain objects and arrays, redacting every string leaf with {@link redactText}.
 * Leaves Date, Map, Set, etc. as shallow copies of references (unlikely in queue payloads).
 */
export function redactValue<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value) as T;
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    const arr = value as unknown[];
    return arr.map((item) => redactValue(item)) as T;
  }

  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = redactValue((value as Record<string, unknown>)[key]);
    }
    return out as T;
  }

  return value;
}
