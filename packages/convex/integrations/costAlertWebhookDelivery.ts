'use node';

import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import {
  assertPublicWebhookAddress,
  isIpAddress,
  normalizeWebhookHeaders,
  normalizeWebhookHostname,
  parseWebhookDeliveryUrl,
  type WebhookHeader,
} from '../costAlertWebhookSecurity';

// Convex actions abort after ~600s; keep per-attempt timeouts tight so a stalled DNS
// resolver or webhook endpoint cannot consume most of that wall-clock budget.
const WEBHOOK_DNS_LOOKUP_TIMEOUT_MS = 5_000;
// Matches other outbound Convex fetch limits (e.g. models.dev import at 15s).
const WEBHOOK_REQUEST_TIMEOUT_MS = 15_000;

export type WebhookAddressResolver = (hostname: string) => Promise<string[]>;
export type WebhookRequestSender = (request: PinnedWebhookRequest) => Promise<WebhookResponse>;

interface WebhookDeliveryTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

export interface PinnedWebhookRequest extends WebhookDeliveryTarget {
  headers: Headers;
  body: string;
}

interface WebhookResponse {
  ok: boolean;
  status: number;
  body: string;
}

interface WebhookNotificationConfig {
  url: string;
  secret?: string;
  headers?: WebhookHeader[];
}

interface WebhookNotificationOptions {
  sendRequest?: WebhookRequestSender;
  resolveAddresses?: WebhookAddressResolver;
}

export async function sendCostAlertWebhookNotification(
  config: WebhookNotificationConfig,
  payload: Record<string, unknown>,
  idempotencyKey: string,
  options: WebhookNotificationOptions = {},
): Promise<void> {
  const body = JSON.stringify(payload);
  const target = await assertCostAlertWebhookDeliveryTarget(
    config.url,
    options.resolveAddresses ?? resolveWebhookAddresses,
  );
  const headers = buildCostAlertWebhookHeaders(config, body, idempotencyKey);
  const sendRequest = options.sendRequest ?? sendPinnedWebhookRequest;

  const response = await sendRequest({
    ...target,
    body,
    headers,
  });

  if (!response.ok) {
    const message = response.body.slice(0, 500);
    throw new Error(`Webhook delivery failed: ${response.status} ${message}`);
  }
}

export async function assertCostAlertWebhookDeliveryTarget(
  rawUrl: string,
  resolveAddresses: WebhookAddressResolver = resolveWebhookAddresses,
): Promise<WebhookDeliveryTarget> {
  const url = parseWebhookDeliveryUrl(rawUrl);
  const hostname = normalizeWebhookHostname(url.hostname);
  const addresses = await resolveAddresses(hostname);

  if (addresses.length === 0) {
    throw new Error('Webhook URL did not resolve to any addresses');
  }

  for (const address of addresses) {
    assertPublicWebhookAddress(address);
  }

  const address = addresses[0];
  if (!address) {
    throw new Error('Webhook URL did not resolve to any addresses');
  }

  return {
    url,
    address: normalizeWebhookHostname(address),
    family: getAddressFamily(address),
  };
}

export async function resolveWebhookAddresses(hostname: string): Promise<string[]> {
  const normalized = normalizeWebhookHostname(hostname);
  if (isIpAddress(normalized)) {
    return [normalized];
  }

  const records = await rejectAfter(
    lookup(normalized, { all: true, verbatim: true }),
    WEBHOOK_DNS_LOOKUP_TIMEOUT_MS,
    `DNS lookup for ${normalized}`,
  );
  return records.map((record) => normalizeWebhookHostname(record.address));
}

export async function sendPinnedWebhookRequest({
  url,
  address,
  family,
  body,
  headers,
}: PinnedWebhookRequest): Promise<WebhookResponse> {
  return new Promise((resolve, reject) => {
    const hostname = normalizeWebhookHostname(url.hostname);
    const requestOptions: RequestOptions & { servername?: string; signal?: AbortSignal } = {
      protocol: url.protocol,
      hostname,
      port: url.port ? Number(url.port) : undefined,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: headersToRecord(headers),
      lookup: createPinnedLookup(address, family),
      family,
      agent: false,
      signal: AbortSignal.timeout(WEBHOOK_REQUEST_TIMEOUT_MS),
    };

    if (url.protocol === 'https:' && !isIpAddress(hostname)) {
      requestOptions.servername = hostname;
    }

    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      requestOptions,
      (response) => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          if (responseBody.length < 500) {
            responseBody += chunk.slice(0, 500 - responseBody.length);
          }
        });
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          resolve({ ok: status >= 200 && status < 300, status, body: responseBody });
        });
      },
    );

    request.on('error', (error) => {
      if (error.name === 'TimeoutError') {
        reject(new Error(`Webhook request timed out after ${WEBHOOK_REQUEST_TIMEOUT_MS}ms`));
        return;
      }
      reject(error);
    });
    request.end(body);
  });
}

function rejectAfter<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  });
}

export function createPinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address, family }]);
      return;
    }

    callback(null, address, family);
  };
}

function buildCostAlertWebhookHeaders(
  config: WebhookNotificationConfig,
  body: string,
  idempotencyKey: string,
): Headers {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey,
  });

  for (const header of normalizeWebhookHeaders(config.headers)) {
    headers.set(header.key, header.value);
  }

  if (config.secret) {
    const signature = createHmac('sha256', config.secret).update(body).digest('hex');
    headers.set('X-Trace-Flow-Signature', signature);
  }

  return headers;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function getAddressFamily(address: string): 4 | 6 {
  return normalizeWebhookHostname(address).includes(':') ? 6 : 4;
}
