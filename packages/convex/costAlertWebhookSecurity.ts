export interface WebhookHeader {
  key: string;
  value: string;
}

const FORBIDDEN_WEBHOOK_HEADER_NAMES = new Set([
  'authorization',
  'connection',
  'content-length',
  'content-type',
  'cookie',
  'expect',
  'forwarded',
  'host',
  'idempotency-key',
  'proxy-authorization',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'x-trace-flow-signature',
]);

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'metadata.internal',
]);

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const BLOCKED_IPV4_RANGES: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

export function normalizeWebhookHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  const withoutBrackets =
    trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  return withoutBrackets.endsWith('.') ? withoutBrackets.slice(0, -1) : withoutBrackets;
}

export function normalizeWebhookHeaders(headers: WebhookHeader[] | undefined): WebhookHeader[] {
  const normalized: WebhookHeader[] = [];

  for (const header of headers ?? []) {
    const key = header.key.trim();
    const value = header.value.trim();
    if (key.length === 0 || value.length === 0) {
      continue;
    }

    validateWebhookHeader(key, value);
    normalized.push({ key, value });
  }

  return normalized;
}

export function parseWebhookDeliveryUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Webhook URL must be a valid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Webhook URL must start with http:// or https://');
  }

  if (url.username || url.password) {
    throw new Error('Webhook URL must not include credentials');
  }

  const hostname = normalizeWebhookHostname(url.hostname);
  if (hostname.length === 0) {
    throw new Error('Webhook URL must include a host');
  }

  if (isBlockedWebhookHostname(hostname)) {
    throw new Error('Webhook URL host is not allowed');
  }

  if (isIpAddress(hostname) && isBlockedIpAddress(hostname)) {
    throw new Error('Webhook URL cannot target private or link-local addresses');
  }

  return url;
}

export function assertPublicWebhookAddress(address: string): void {
  const normalized = normalizeWebhookHostname(address);
  if (!isIpAddress(normalized)) {
    throw new Error('Resolved webhook address is not a valid IP address');
  }

  if (isBlockedIpAddress(normalized)) {
    throw new Error(
      'Webhook URL cannot resolve to private, loopback, link-local, metadata, or reserved addresses',
    );
  }
}

export function isIpAddress(address: string): boolean {
  return parseIpv4Address(address) !== null || parseIpv6Address(address) !== null;
}

function validateWebhookHeader(key: string, value: string): void {
  if (!HEADER_NAME_PATTERN.test(key)) {
    throw new Error(`Invalid webhook header name: ${key}`);
  }

  if (FORBIDDEN_WEBHOOK_HEADER_NAMES.has(key.toLowerCase())) {
    throw new Error(`Webhook header "${key}" is not allowed`);
  }

  if (value.includes('\r') || value.includes('\n')) {
    throw new Error(`Webhook header "${key}" contains invalid characters`);
  }
}

function isBlockedWebhookHostname(hostname: string): boolean {
  return BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost');
}

function isBlockedIpAddress(address: string): boolean {
  const ipv4 = parseIpv4Address(address);
  if (ipv4 !== null) {
    return isBlockedIpv4Address(ipv4);
  }

  const ipv6 = parseIpv6Address(address);
  return ipv6 !== null && isBlockedIpv6Address(ipv6);
}

function isBlockedIpv4Address(address: number): boolean {
  return BLOCKED_IPV4_RANGES.some(([base, prefix]) => {
    const baseAddress = parseIpv4Address(base);
    if (baseAddress === null) {
      return false;
    }

    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (address & mask) === (baseAddress & mask);
  });
}

function parseIpv4Address(address: string): number | null {
  const parts = normalizeWebhookHostname(address).split('.');
  if (parts.length !== 4) {
    return null;
  }

  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }

    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return null;
    }

    value = value * 256 + octet;
  }

  return value >>> 0;
}

function isBlockedIpv6Address(address: bigint): boolean {
  const mappedIpv4 = extractMappedIpv4(address);
  if (mappedIpv4 !== null) {
    return isBlockedIpv4Address(mappedIpv4);
  }

  if (address === 0n || address === 1n) {
    return true;
  }

  const first = Number((address >> 112n) & 0xffffn);
  const second = Number((address >> 96n) & 0xffffn);

  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xff00) === 0xff00) return true;
  if (first === 0x0100 && second === 0) return true;
  // Teredo embeds an obfuscated IPv4 address, so block its full prefix.
  if (first === 0x2001 && second === 0x0000) return true;
  if (first === 0x2001 && second === 0x0db8) return true;
  if (first === 0x2002) return true;

  return false;
}

function extractMappedIpv4(address: bigint): number | null {
  if (address <= 0xffffffffn) {
    return Number(address);
  }

  if (address >> 32n === 0xffffn) {
    return Number(address & 0xffffffffn);
  }

  const nat64Prefix = parseIpv6Address('64:ff9b::');
  if (nat64Prefix !== null && address >> 32n === nat64Prefix >> 32n) {
    return Number(address & 0xffffffffn);
  }

  return null;
}

function parseIpv6Address(address: string): bigint | null {
  const normalized = normalizeWebhookHostname(address);
  if (normalized.includes('%')) {
    return null;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) {
    return null;
  }

  const head = halves[0] ?? '';
  const tail = halves[1] ?? '';
  const headGroups = head.length > 0 ? parseIpv6Groups(head) : [];
  const tailGroups = tail.length > 0 ? parseIpv6Groups(tail) : [];
  if (!headGroups || !tailGroups) {
    return null;
  }

  const hasCompression = halves.length === 2;
  const missingGroups = 8 - headGroups.length - tailGroups.length;
  if ((!hasCompression && missingGroups !== 0) || (hasCompression && missingGroups < 1)) {
    return null;
  }

  const groups = hasCompression
    ? [...headGroups, ...Array.from({ length: missingGroups }, () => 0), ...tailGroups]
    : [...headGroups, ...tailGroups];

  if (groups.length !== 8) {
    return null;
  }

  return groups.reduce((value, group) => (value << 16n) + BigInt(group), 0n);
}

function parseIpv6Groups(value: string): number[] | null {
  const groups: number[] = [];
  const parts = value.split(':');

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? '';
    if (part.includes('.')) {
      if (index !== parts.length - 1) {
        return null;
      }

      const ipv4 = parseIpv4Address(part);
      if (ipv4 === null) {
        return null;
      }

      groups.push((ipv4 >>> 16) & 0xffff, ipv4 & 0xffff);
      continue;
    }

    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) {
      return null;
    }

    groups.push(parseInt(part, 16));
  }

  return groups;
}
