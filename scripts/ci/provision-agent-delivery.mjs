const API_ROOT = 'https://api.cloudflare.com/client/v4';
export const SNAPSHOT_QUEUE_RETENTION_SECONDS = 4 * 24 * 60 * 60;

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function cloudflareResponse(fetchImpl, accountId, apiToken, path, init = {}) {
  const response = await fetchImpl(`${API_ROOT}/accounts/${accountId}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const body = await response.json();
  if (!response.ok || body.success !== true) {
    const message =
      body.errors?.map((error) => error.message).join('; ') || `HTTP ${response.status}`;
    throw new Error(`Cloudflare API ${init.method ?? 'GET'} ${path} failed: ${message}`);
  }
  return body;
}

async function cloudflare(fetchImpl, accountId, apiToken, path, init = {}) {
  return (await cloudflareResponse(fetchImpl, accountId, apiToken, path, init)).result;
}

async function listQueues(fetchImpl, accountId, apiToken) {
  const queues = [];
  for (let page = 1; page <= 20; page += 1) {
    const body = await cloudflareResponse(
      fetchImpl,
      accountId,
      apiToken,
      `/queues?page=${page}&per_page=100`,
    );
    if (!Array.isArray(body.result)) throw new Error('Cloudflare returned an invalid queue list');
    queues.push(...body.result);
    const totalPages = body.result_info?.total_pages;
    if (totalPages !== undefined) {
      if (!Number.isSafeInteger(totalPages) || totalPages < 0 || totalPages > 20) {
        throw new Error('Cloudflare queue listing exceeded the supported bound');
      }
      if (totalPages === 0 && body.result.length === 0) return queues;
      if (page >= totalPages) return queues;
    } else if (body.result.length < 100) {
      return queues;
    }
  }
  throw new Error('Cloudflare queue listing exceeded the supported bound');
}

export async function provisionAgentDelivery(environment, options = {}) {
  if (!['dev', 'prod'].includes(environment)) throw new Error('environment must be dev or prod');
  const fetchImpl = options.fetchImpl ?? fetch;
  const accountId = required(
    options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID,
    'CLOUDFLARE_ACCOUNT_ID',
  );
  const apiToken = required(
    options.apiToken ?? process.env.CLOUDFLARE_API_TOKEN,
    'CLOUDFLARE_API_TOKEN',
  );
  const bucketName = `trace-flow-agent-deliveries-${environment}`;
  const queueName = `agent-snapshot-${environment}`;

  const bucketPath = `/r2/buckets/${encodeURIComponent(bucketName)}`;
  const bucketResponse = await fetchImpl(`${API_ROOT}/accounts/${accountId}${bucketPath}`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (bucketResponse.status === 404) {
    await cloudflare(fetchImpl, accountId, apiToken, '/r2/buckets', {
      method: 'POST',
      body: JSON.stringify({ name: bucketName }),
    });
  } else {
    const body = await bucketResponse.json();
    if (!bucketResponse.ok || body.success !== true || body.result?.name !== bucketName) {
      throw new Error(`Cloudflare API GET ${bucketPath} failed`);
    }
  }

  const queues = await listQueues(fetchImpl, accountId, apiToken);
  const matches = queues.filter((queue) => queue.queue_name === queueName);
  if (matches.length > 1) throw new Error(`Cloudflare returned duplicate queue ${queueName}`);
  let queue = matches[0];
  if (!queue) {
    queue = await cloudflare(fetchImpl, accountId, apiToken, '/queues', {
      method: 'POST',
      body: JSON.stringify({ queue_name: queueName }),
    });
  }
  if (!queue?.queue_id || queue.queue_name !== queueName) {
    throw new Error(`Cloudflare returned an invalid queue receipt for ${queueName}`);
  }

  if (queue.settings?.message_retention_period !== SNAPSHOT_QUEUE_RETENTION_SECONDS) {
    const settings = {
      ...(queue.settings?.delivery_delay === undefined
        ? {}
        : { delivery_delay: queue.settings.delivery_delay }),
      ...(queue.settings?.delivery_paused === undefined
        ? {}
        : { delivery_paused: queue.settings.delivery_paused }),
      message_retention_period: SNAPSHOT_QUEUE_RETENTION_SECONDS,
    };
    queue = await cloudflare(fetchImpl, accountId, apiToken, `/queues/${queue.queue_id}`, {
      method: 'PUT',
      body: JSON.stringify({ queue_name: queueName, settings }),
    });
  }
  if (queue.settings?.message_retention_period !== SNAPSHOT_QUEUE_RETENTION_SECONDS) {
    throw new Error(`${queueName} did not retain the required four-day message retention`);
  }

  return { bucketName, queueName };
}

if (import.meta.main) {
  const environment = process.argv[2];
  const result = await provisionAgentDelivery(environment);
  console.log(`Provisioned ${result.bucketName} and ${result.queueName} with four-day retention.`);
}
