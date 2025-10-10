import type { QueueMessage } from '@observe/shared/types';

interface Env {
  // STORAGE?: R2Bucket;
  CLICKHOUSE_HOST?: string;
  CLICKHOUSE_USER?: string;
  CLICKHOUSE_PASSWORD?: string;
}

export default {
  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await processMessage(message.body, env);
      message.ack();
    }
  },
};

async function processMessage(_data: QueueMessage, _env: Env): Promise<void> {
  // await storeInR2(data, env);
  // await writeToClickHouse(data, env);
}

// async function storeInR2(data: QueueMessage, env: Env): Promise<void> {
//   if (!env.STORAGE) return;
//
//   const requestKey = `requests/${data.requestId}/request.json`;
//   const responseKey = `requests/${data.requestId}/response.json`;
//
//   await env.STORAGE.put(requestKey, data.requestBody);
//   await env.STORAGE.put(responseKey, data.responseBody);
// }

// async function writeToClickHouse(data: QueueMessage, env: Env): Promise<void> {
//   if (!env.CLICKHOUSE_HOST) return;
//
//   const row = {
//     id: data.requestId,
//     provider: data.request.provider,
//     model: data.request.model,
//     status: data.response.status,
//     latency: data.response.latency,
//     timestamp: data.request.timestamp,
//   };
//
//   const url = `${env.CLICKHOUSE_HOST}/?query=INSERT INTO llm_requests FORMAT JSONEachRow`;
//   await fetch(url, {
//     method: 'POST',
//     headers: {
//       'Content-Type': 'application/json',
//       'X-ClickHouse-User': env.CLICKHOUSE_USER || '',
//       'X-ClickHouse-Key': env.CLICKHOUSE_PASSWORD || '',
//     },
//     body: JSON.stringify(row),
//   });
// }
