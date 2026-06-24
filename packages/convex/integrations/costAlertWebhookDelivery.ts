'use node';

import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import {
  assertPublicWebhookAddress,
  isIpAddress,
  normalizeWebhookHeaders,
  normalizeWebhookHostname,
  parseWebhookDeliveryUrl,
  type WebhookHeader,
} from '../costAlertWebhookSecurity';

type WebhookFetch = (url: string, init: RequestInit) => Promise<Response>;
export type WebhookAddressResolver = (hostname: string) => Promise<string[]>;

interface WebhookNotificationConfig {
  url: string;
  secret?: string;
  headers?: WebhookHeader[];
}

interface WebhookNotificationOptions {
  fetchImpl?: WebhookFetch;
  resolveAddresses?: WebhookAddressResolver;
}

export async function sendCostAlertWebhookNotification(
  config: WebhookNotificationConfig,
  payload: Record<string, unknown>,
  idempotencyKey: string,
  options: WebhookNotificationOptions = {},
): Promise<void> {
  const body = JSON.stringify(payload);
  const url = await assertCostAlertWebhookDeliveryTarget(
    config.url,
    options.resolveAddresses ?? resolveWebhookAddresses,
  );
  const headers = buildCostAlertWebhookHeaders(config, body, idempotencyKey);
  const fetchImpl = options.fetchImpl ?? fetch;

  const response = await fetchImpl(url.toString(), {
    method: 'POST',
    headers,
    body,
    redirect: 'error',
  });

  if (!response.ok) {
    const message = (await response.text()).slice(0, 500);
    throw new Error(`Webhook delivery failed: ${response.status} ${message}`);
  }
}

export async function assertCostAlertWebhookDeliveryTarget(
  rawUrl: string,
  resolveAddresses: WebhookAddressResolver = resolveWebhookAddresses,
): Promise<URL> {
  const url = parseWebhookDeliveryUrl(rawUrl);
  const hostname = normalizeWebhookHostname(url.hostname);
  const addresses = await resolveAddresses(hostname);

  if (addresses.length === 0) {
    throw new Error('Webhook URL did not resolve to any addresses');
  }

  for (const address of addresses) {
    assertPublicWebhookAddress(address);
  }

  return url;
}

export async function resolveWebhookAddresses(hostname: string): Promise<string[]> {
  const normalized = normalizeWebhookHostname(hostname);
  if (isIpAddress(normalized)) {
    return [normalized];
  }

  const records = await lookup(normalized, { all: true, verbatim: true });
  return records.map((record) => normalizeWebhookHostname(record.address));
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
