import { describe, expect, test } from 'bun:test';
import {
  provisionAgentDelivery,
  SNAPSHOT_QUEUE_RETENTION_SECONDS,
} from './provision-agent-delivery.mjs';

function response(status, result, errors = [], resultInfo) {
  return new Response(
    JSON.stringify({ success: status < 400, result, errors, result_info: resultInfo }),
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

function harness({ bucketExists = true, queue, queuePages } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace('/client/v4/accounts/account', '');
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, search: parsed.search, method, body });
    if (path.startsWith('/r2/buckets/')) {
      return bucketExists
        ? response(200, { name: 'trace-flow-agent-deliveries-dev' })
        : response(404, null, [{ message: 'not found' }]);
    }
    if (path === '/r2/buckets') return response(200, { name: body.name });
    if (path === '/queues' && method === 'GET') {
      const page = Number(parsed.searchParams.get('page'));
      const pages = queuePages ?? [queue ? [queue] : []];
      return response(200, pages[page - 1] ?? [], [], {
        page,
        per_page: 100,
        total_pages: pages.length,
      });
    }
    if (path === '/queues' && method === 'POST') {
      return response(200, { queue_id: 'queue-id', queue_name: body.queue_name, settings: {} });
    }
    if (path === '/queues/queue-id' && method === 'PUT') {
      return response(200, {
        queue_id: 'queue-id',
        queue_name: body.queue_name,
        settings: body.settings,
      });
    }
    throw new Error(`Unexpected ${method} ${path}`);
  };
  return { calls, fetchImpl };
}

describe('agent delivery infrastructure provisioning', () => {
  test('creates missing resources and sets four-day queue retention', async () => {
    const { calls, fetchImpl } = harness({ bucketExists: false });
    await expect(
      provisionAgentDelivery('dev', { fetchImpl, accountId: 'account', apiToken: 'token' }),
    ).resolves.toEqual({
      bucketName: 'trace-flow-agent-deliveries-dev',
      queueName: 'agent-snapshot-dev',
    });
    expect(calls).toContainEqual({
      path: '/r2/buckets',
      search: '',
      method: 'POST',
      body: { name: 'trace-flow-agent-deliveries-dev' },
    });
    expect(calls.at(-1).body.settings.message_retention_period).toBe(
      SNAPSHOT_QUEUE_RETENTION_SECONDS,
    );
  });

  test('leaves compliant resources unchanged', async () => {
    const queue = {
      queue_id: 'queue-id',
      queue_name: 'agent-snapshot-dev',
      settings: { message_retention_period: SNAPSHOT_QUEUE_RETENTION_SECONDS },
    };
    const { calls, fetchImpl } = harness({ queue });
    await provisionAgentDelivery('dev', { fetchImpl, accountId: 'account', apiToken: 'token' });
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  test('preserves queue settings while repairing retention', async () => {
    const queue = {
      queue_id: 'queue-id',
      queue_name: 'agent-snapshot-dev',
      settings: { delivery_delay: 9, delivery_paused: true, message_retention_period: 60 },
    };
    const { calls, fetchImpl } = harness({ queue });
    await provisionAgentDelivery('dev', { fetchImpl, accountId: 'account', apiToken: 'token' });
    expect(calls.at(-1).body.settings).toEqual({
      delivery_delay: 9,
      delivery_paused: true,
      message_retention_period: SNAPSHOT_QUEUE_RETENTION_SECONDS,
    });
  });

  test('finds an existing queue on a later API page', async () => {
    const queue = {
      queue_id: 'queue-id',
      queue_name: 'agent-snapshot-dev',
      settings: { message_retention_period: SNAPSHOT_QUEUE_RETENTION_SECONDS },
    };
    const { calls, fetchImpl } = harness({
      queuePages: [[{ queue_id: 'other', queue_name: 'other', settings: {} }], [queue]],
    });
    await provisionAgentDelivery('dev', { fetchImpl, accountId: 'account', apiToken: 'token' });
    expect(calls.filter((call) => call.path === '/queues')).toHaveLength(2);
    expect(calls.some((call) => call.search === '?page=2&per_page=100')).toBe(true);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  test('rejects unknown environments before making requests', async () => {
    await expect(
      provisionAgentDelivery('preview', {
        fetchImpl: () => {
          throw new Error('called');
        },
        accountId: 'account',
        apiToken: 'token',
      }),
    ).rejects.toThrow('environment must be dev or prod');
  });
});
